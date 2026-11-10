# Affiche le mot de passe initial du compte admin d'ArgoCD (généré à l'installation,
# stocké dans le Secret argocd-initial-admin-secret du cluster).
# Usage : powershell -ExecutionPolicy Bypass -File scripts\argocd-mot-de-passe.ps1
$encode = kubectl -n argocd get secret argocd-initial-admin-secret -o 'jsonpath={.data.password}'
if (-not $encode) { Write-Host 'Secret introuvable : le cluster tourne-t-il ? Le mot de passe a-t-il déjà été changé ?'; exit 1 }
Write-Host ''
Write-Host 'Interface : https://localhost:8443'
Write-Host 'Utilisateur : admin'
Write-Host ('Mot de passe : ' + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encode)))
Write-Host ''
