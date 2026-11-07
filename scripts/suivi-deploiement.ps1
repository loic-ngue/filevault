# R-07 : suit un git push jusqu'au cluster, en interrogeant l'application en continu.
#   pipeline GitHub Actions -> commit de déploiement (étape 7) -> synchronisation ArgoCD -> pods à jour
# À lancer juste après un git push sur main.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\suivi-deploiement.ps1 [-Commit <sha>] [-Rafraichir]
#   -Rafraichir : demande à ArgoCD de relire Git tout de suite, au lieu d'attendre son
#                 interrogation périodique (3 minutes au plus).
param([string]$Commit = (git rev-parse HEAD), [switch]$Rafraichir, [int]$MinutesMax = 20)

$ErrorActionPreference = 'Continue'
$depot = 'loic-ngue/filevault'
$entetes = @('-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: filevault-suivi')
function Api([string]$chemin) { (curl.exe -s @entetes "https://api.github.com/repos/$depot$chemin" | Out-String) | ConvertFrom-Json }
function Sonde {
    # Une requête vers le frontend et une vers link-service, à travers l'Ingress.
    $a = curl.exe -sk -m 5 -o NUL -w '%{http_code}' --resolve filevault.local:443:127.0.0.1 https://filevault.local/
    $b = curl.exe -sk -m 5 -o NUL -w '%{http_code}' --resolve filevault.local:443:127.0.0.1 https://filevault.local/api/links/inconnu
    ($a -eq '200') -and ($b -eq '410')
}
function Images { kubectl -n filevault get deploy -o 'jsonpath={range .items[*]}{.spec.template.spec.containers[0].image}{" "}{.status.updatedReplicas}/{.status.readyReplicas}/{.status.replicas}{";"}{end}' }

$court = $Commit.Substring(0, 7)
$chrono = [Diagnostics.Stopwatch]::StartNew()
$requetes = 0; $echecs = 0
$etape = 'pipeline'
$jalons = [ordered]@{}
Write-Host "Suivi du commit $court"

while ($chrono.Elapsed.TotalMinutes -lt $MinutesMax) {
    $requetes++
    if (-not (Sonde)) { $echecs++ }

    if ($etape -eq 'pipeline' -and ($requetes % 10 -eq 1)) {
        $run = (Api "/actions/runs?head_sha=$Commit").workflow_runs | Select-Object -First 1
        if ($run.status -eq 'completed') {
            $jalons['Pipeline terminé'] = $chrono.Elapsed
            Write-Host ("{0,5} s  pipeline : {1}" -f [int]$chrono.Elapsed.TotalSeconds, $run.conclusion)
            if ($run.conclusion -ne 'success') { break }
            $etape = 'commit'
        }
    }
    if ($etape -eq 'commit' -and ($requetes % 5 -eq 1)) {
        git fetch -q origin
        $deploiement = git log origin/main --format='%H %s' -20 | Where-Object { $_ -match "D.ploie $court" } | Select-Object -First 1
        if ($deploiement) {
            $script:revision = ($deploiement -split ' ')[0]
            $jalons['Commit de déploiement'] = $chrono.Elapsed
            Write-Host ("{0,5} s  commit de déploiement {1}" -f [int]$chrono.Elapsed.TotalSeconds, $revision.Substring(0, 7))
            if ($Rafraichir) { kubectl -n argocd annotate application filevault argocd.argoproj.io/refresh=normal --overwrite | Out-Null }
            $etape = 'argocd'
        }
    }
    if ($etape -eq 'argocd') {
        $etat = kubectl -n argocd get application filevault -o 'jsonpath={.status.sync.revision}'
        if ($etat -eq $revision) {
            $jalons['ArgoCD synchronisé'] = $chrono.Elapsed
            Write-Host ("{0,5} s  ArgoCD a appliqué {1}" -f [int]$chrono.Elapsed.TotalSeconds, $revision.Substring(0, 7))
            $etape = 'pods'
        }
    }
    if ($etape -eq 'pods') {
        $etats = (Images) -split ';' | Where-Object { $_ }
        $prets = @($etats | Where-Object { $_ -match ":$Commit (\d+)/\1/\1$" })
        if ($prets.Count -eq $etats.Count) {
            $jalons['Pods à jour'] = $chrono.Elapsed
            Write-Host ("{0,5} s  les {1} Deployments tournent l'image {2}" -f [int]$chrono.Elapsed.TotalSeconds, $etats.Count, $court)
            $etape = 'fini'
            break
        }
    }
    Start-Sleep 2
}

Write-Host ''
Write-Host "Requêtes pendant le déploiement : $requetes, en échec : $echecs"
if ($etape -eq 'fini' -and $echecs -eq 0) {
    Write-Host "OK     R-07    git push -> nouvelle version en production en $([int]$chrono.Elapsed.TotalSeconds) s, sans coupure"
    exit 0
}
Write-Host "ECHEC  R-07    arrêt à l'étape « $etape », $echecs requête(s) en échec"
exit 1
