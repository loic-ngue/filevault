function Suspendre-ArgoCD {
    if (-not (kubectl -n argocd get application filevault --ignore-not-found -o name 2>$null)) { return $false }
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
