# Ouvre l'interface ArgoCD sur https://localhost:8443 et garde le tunnel ouvert :
# kubectl port-forward s'arrête si le pod argocd-server redémarre, on le relance alors.
# Arrêt : Ctrl+C dans ce terminal.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\argocd-ui.ps1
$ErrorActionPreference = 'Continue'
Write-Host 'Interface ArgoCD : https://localhost:8443  (utilisateur admin)'
Write-Host 'Mot de passe : voir docs/captures/README.md. Laisser ce terminal ouvert.'
while ($true) {
    kubectl -n argocd port-forward svc/argocd-server 8443:443
    Write-Host 'Tunnel coupé (pod redémarré ?), reconnexion dans 3 s…'
    Start-Sleep 3
}
