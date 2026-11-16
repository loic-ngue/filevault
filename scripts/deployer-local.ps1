$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$services = 'link-service', 'upload-service', 'download-service', 'cleanup', 'frontend'

foreach ($service in $services) {
    Write-Host "Construction de filevault/${service}:dev"
    docker build -q -t "filevault/${service}:dev" (Join-Path $root "services\$service") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Échec de la construction de $service." }
}

function Test-KindNode([string]$name) {
    $ErrorActionPreference = 'Continue'
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

foreach ($deployment in 'link-service', 'upload-service', 'download-service', 'frontend') {
    kubectl -n filevault set image "deployment/$deployment" "$deployment=filevault/${deployment}:dev" | Out-Null
}
kubectl -n filevault set image cronjob/cleanup 'cleanup=filevault/cleanup:dev' | Out-Null

kubectl -n filevault rollout restart deployment link-service upload-service download-service frontend
foreach ($deployment in 'link-service', 'upload-service', 'download-service', 'frontend') {
    kubectl -n filevault rollout status deployment $deployment --timeout=180s
}
kubectl -n filevault get pods
