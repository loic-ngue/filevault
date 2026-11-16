$ErrorActionPreference = 'Continue'
Write-Host 'Interface ArgoCD : https://localhost:8443  (utilisateur admin)'
Write-Host 'Mot de passe : voir docs/captures/README.md. Laisser ce terminal ouvert.'
while ($true) {
    kubectl -n argocd port-forward svc/argocd-server 8443:443
    Write-Host 'Tunnel coupé (pod redémarré ?), reconnexion dans 3 s…'
    Start-Sleep 3
}
