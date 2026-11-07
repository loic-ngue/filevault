# Suspend et rétablit la synchronisation automatique d'ArgoCD, le temps d'un test qui
# modifie le cluster à la main (version défectueuse, levée d'une limite) : sinon
# l'auto-correction d'ArgoCD annulerait la modification en quelques secondes.
# À inclure avec : . (Join-Path $PSScriptRoot 'argocd-pause.ps1')

function Suspendre-ArgoCD {
    if (-not (kubectl -n argocd get application filevault --ignore-not-found -o name 2>$null)) { return $false }
    # Fichier de patch : PowerShell 5.1 retire les guillemets d'un JSON passé en argument.
    $patch = Join-Path $env:TEMP 'filevault-argocd-pause.json'
    '{"spec":{"syncPolicy":{"automated":null}}}' | Set-Content -Encoding ascii $patch
    kubectl -n argocd patch application filevault --type merge --patch-file $patch | Out-Null
    Remove-Item $patch
    Write-Host 'ArgoCD : synchronisation automatique suspendue le temps du test.'
    $true
}

function Reprendre-ArgoCD {
    kubectl apply -f (Join-Path (Split-Path -Parent $PSScriptRoot) 'argocd\application.yaml') | Out-Null
    Write-Host 'ArgoCD : synchronisation automatique rétablie, le cluster se réaligne sur Git.'
}
