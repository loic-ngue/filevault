# Déploiement manuel sur le cluster local, sans registre ni ArgoCD (section 9) :
# construit les 5 images avec l'étiquette dev, les charge dans le cluster, applique k8s/.
# Prérequis : Docker Desktop avec Kubernetes, ingress-nginx, metrics-server,
# puis scripts\creer-secrets.ps1 une fois.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\deployer-local.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$services = 'link-service', 'upload-service', 'download-service', 'cleanup', 'frontend'

foreach ($service in $services) {
    Write-Host "Construction de filevault/${service}:dev"
    docker build -q -t "filevault/${service}:dev" (Join-Path $root "services\$service") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Échec de la construction de $service." }
}

# Cluster Docker Desktop de type kind : les nœuds ont leur propre stock d'images.
# Docker Desktop les cache à docker ps : on interroge chaque nœud par son nom.
function Test-KindNode([string]$name) {
    $ErrorActionPreference = 'Continue' # un nœud inconnu de Docker écrit sur stderr : ce n'est pas une erreur
    docker inspect --format '{{.Name}}' $name 2>$null | Out-Null
    $LASTEXITCODE -eq 0
}
$kindNodes = @((kubectl get nodes -o 'jsonpath={.items[*].metadata.name}') -split ' ' | Where-Object { $_ -and (Test-KindNode $_) })
if ($kindNodes) {
    $archive = Join-Path $env:TEMP 'filevault-images.tar'
    docker save -o $archive ($services | ForEach-Object { "filevault/${_}:dev" })
    foreach ($node in $kindNodes) {
        Write-Host "Chargement des images dans le nœud $node"
        docker cp $archive "${node}:/filevault-images.tar"
        docker exec $node ctr -n k8s.io images import /filevault-images.tar | Out-Null
        docker exec $node rm /filevault-images.tar
    }
    Remove-Item $archive
}

kubectl apply -k (Join-Path $root 'k8s')
if ($LASTEXITCODE -ne 0) { throw 'kubectl apply a échoué.' }

# Même étiquette dev qu'avant : on force le redémarrage pour prendre les nouvelles images.
kubectl -n filevault rollout restart deployment link-service upload-service download-service frontend
foreach ($deployment in 'link-service', 'upload-service', 'download-service', 'frontend') {
    kubectl -n filevault rollout status deployment $deployment --timeout=180s
}
kubectl -n filevault get pods
