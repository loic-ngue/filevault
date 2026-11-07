# Preuves d'exécution (section 11) : enregistre dans docs/captures/ l'état du cluster,
# du pipeline et d'ArgoCD, puis les sorties de la recette et du test de charge.
# Chaque fichier indique sa date et la commande qui l'a produit.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\collecter-preuves.ps1 [-SansTests] [-AttendreExpiration]
#   -SansTests          : seulement l'état (quelques secondes), sans recette ni charge.
#   -AttendreExpiration : recette avec R-04 (11 minutes de plus).
param([switch]$SansTests, [switch]$AttendreExpiration)

$ErrorActionPreference = 'Continue'
$racine = Split-Path -Parent $PSScriptRoot
$sortie = Join-Path $racine 'docs\captures'
New-Item -ItemType Directory -Force $sortie | Out-Null
$ns = 'filevault'
$depot = 'loic-ngue/filevault'
$utf8 = New-Object Text.UTF8Encoding $false

function Preuve([string]$fichier, [string]$titre, [scriptblock[]]$etapes) {
    $lignes = @("# $titre", "# Généré le $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') par scripts/collecter-preuves.ps1", '')
    foreach ($etape in $etapes) {
        $lignes += "PS> $($etape.ToString().Trim())"
        $lignes += (& $etape 2>&1 | ForEach-Object { $_.ToString() })
        $lignes += ''
    }
    [IO.File]::WriteAllLines((Join-Path $sortie $fichier), [string[]]$lignes, $utf8)
    Write-Host "  $fichier"
}
function Api([string]$chemin) {
    (curl.exe -s -H 'Accept: application/vnd.github+json' -H 'User-Agent: filevault-preuves' "https://api.github.com/repos/$depot$chemin" | Out-String) | ConvertFrom-Json
}

Write-Host "Preuves dans $sortie"

Preuve '01-cluster.txt' 'Objets Kubernetes de FileVault (namespace filevault)' @(
    { kubectl get nodes -o wide },
    { kubectl -n filevault get deploy,statefulset,pods,svc -o wide },
    { kubectl -n filevault get hpa,cronjob,ingress,networkpolicy,pvc },
    { kubectl -n filevault get configmap,secret }
)

Preuve '02-securite-conteneurs.txt' 'ES-09 : conteneurs non root, système de fichiers en lecture seule, sans capacités' @(
    { kubectl -n filevault get pods -o 'custom-columns=POD:.metadata.name,NON_ROOT:.spec.securityContext.runAsNonRoot,UTILISATEUR:.spec.securityContext.runAsUser,LECTURE_SEULE:.spec.containers[0].securityContext.readOnlyRootFilesystem,ESCALADE:.spec.containers[0].securityContext.allowPrivilegeEscalation,CAPACITES_RETIREES:.spec.containers[0].securityContext.capabilities.drop' }
)

Preuve '03-argocd.txt' 'ArgoCD : application synchronisée sur Git (étape 8)' @(
    { kubectl -n argocd get application filevault -o 'custom-columns=APPLICATION:.metadata.name,SYNC:.status.sync.status,SANTE:.status.health.status,REVISION:.status.sync.revision,DEPOT:.spec.source.repoURL,DOSSIER:.spec.source.path' },
    { ((kubectl -n argocd get application filevault -o json | Out-String) | ConvertFrom-Json).status.history | Select-Object -Last 8 | ForEach-Object { '{0}  révision {1}  déployée le {2}' -f $_.id, $_.revision.Substring(0, 7), $_.deployedAt } },
    { kubectl -n filevault get deploy -o 'custom-columns=DEPLOYMENT:.metadata.name,PRETS:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image' },
    { git -C $racine log --oneline -12 }
)

Preuve '04-pipeline.txt' 'GitHub Actions : dernières exécutions du pipeline CI/CD' @(
    { (Api '/actions/runs?per_page=6').workflow_runs | ForEach-Object { '{0}  {1,-10} {2,-8} commit {3}  {4}' -f $_.created_at, $_.conclusion, $_.event, $_.head_sha.Substring(0, 7), $_.html_url } },
    { $run = (Api '/actions/runs?per_page=1&status=success').workflow_runs[0]; "Détail de l'exécution $($run.id) (commit $($run.head_sha.Substring(0, 7))) :"; (Api "/actions/runs/$($run.id)/jobs?per_page=30").jobs | ForEach-Object { '  {0,-9} {1,-28} {2,4} s' -f $_.conclusion, $_.name, [int]([datetime]$_.completed_at - [datetime]$_.started_at).TotalSeconds } }
)

Preuve '05-trivy-images-deployees.txt' 'ES-10 : scan Trivy des images en production (aucune faille critique corrigeable)' @(
    {
        $trivy = 'ghcr.io/aquasecurity/trivy@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c'
        $images = kubectl -n filevault get deploy -o 'jsonpath={.items[*].spec.template.spec.containers[0].image}'
        foreach ($image in ($images -split ' ')) {
            docker run --rm -v //var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache $trivy image --skip-version-check --quiet --severity CRITICAL --ignore-unfixed --exit-code 1 --format table $image | Out-Null
            '{0,-70} {1}' -f $image, $(if ($LASTEXITCODE -eq 0) { 'aucune faille critique' } else { 'FAILLE CRITIQUE' })
        }
    }
)

if (-not $SansTests) {
    $option = if ($AttendreExpiration) { @('-AttendreExpiration') } else { @() }
    Preuve '06-recette.txt' 'Recette sur le cluster (section 13), à travers l''Ingress HTTPS' @(
        { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'recette.ps1') @option }
    )
    Preuve '07-hpa-charge.txt' 'R-09 : montée en charge, le HPA ajoute des copies d''upload-service' @(
        { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-charge.ps1') }
    )
    Preuve '08-rollback.txt' 'R-10 : historique des versions et retour arrière' @(
        { kubectl -n filevault rollout history deployment link-service },
        { Get-Content (Join-Path $sortie '06-recette.txt') | Select-String 'R-10' | ForEach-Object { $_.Line } }
    )
}
Write-Host 'Terminé.'
