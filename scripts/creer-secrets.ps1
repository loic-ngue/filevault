# Crée les Secrets Kubernetes de FileVault, hors de Git (ES-07) :
#   filevault-secrets : clé maître, jetons, identifiants Redis et MinIO
#   filevault-tls     : certificat auto-signé pour https://filevault.local (ES-06)
#
# Sans effet sur un secret qui existe déjà : la clé maître n'est jamais remplacée,
# sinon tous les fichiers stockés deviendraient illisibles.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\creer-secrets.ps1
$ErrorActionPreference = 'Stop'
$namespace = 'filevault'
$backup = Join-Path $env:USERPROFILE 'filevault-secrets.txt'

function New-RandomBase64([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    [Convert]::ToBase64String($buffer)
}
function New-RandomHex([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    -join ($buffer | ForEach-Object { $_.ToString('x2') })
}
function Test-Secret([string]$name) {
    [bool](kubectl get secret $name -n $namespace --ignore-not-found -o name)
}

kubectl create namespace $namespace --dry-run=client -o yaml | kubectl apply -f - | Out-Null

if (Test-Secret 'filevault-secrets') {
    Write-Host "filevault-secrets existe déjà : inchangé."
} else {
    $redisPassword = New-RandomHex 24
    $values = [ordered]@{
        MASTER_KEY          = New-RandomBase64 32
        INTERNAL_TOKEN      = New-RandomHex 32
        ADMIN_TOKEN         = New-RandomHex 16
        REDIS_PASSWORD      = $redisPassword
        REDIS_URL           = "redis://:$redisPassword@redis:6379"
        MINIO_ROOT_USER     = 'filevault'
        MINIO_ROOT_PASSWORD = New-RandomHex 24
    }
    $literals = $values.GetEnumerator() | ForEach-Object { "--from-literal=$($_.Key)=$($_.Value)" }
    kubectl create secret generic filevault-secrets -n $namespace @literals | Out-Null

    # Risque « perte de la clé maître » (section 14) : copie de sauvegarde hors du dépôt.
    $values.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -Encoding utf8 $backup
    Write-Host "filevault-secrets créé. Sauvegarde, jeton administrateur compris : $backup (à garder hors du dépôt)."
}

if (Test-Secret 'filevault-tls') {
    Write-Host "filevault-tls existe déjà : inchangé."
} else {
    # openssl est fourni avec Git pour Windows.
    $openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
    if (-not $openssl) { $openssl = 'C:\Program Files\Git\usr\bin\openssl.exe' }
    $dir = Join-Path $env:TEMP 'filevault-tls'
    New-Item -ItemType Directory -Force $dir | Out-Null
    # openssl écrit sa progression sur stderr : ce n'est pas une erreur en soi.
    $ErrorActionPreference = 'Continue'
    & $openssl req -x509 -nodes -newkey rsa:2048 -days 365 `
        -keyout "$dir\tls.key" -out "$dir\tls.crt" `
        -subj '/CN=filevault.local' -addext 'subjectAltName=DNS:filevault.local' 2>$null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "openssl a échoué ($openssl)." }
    kubectl create secret tls filevault-tls -n $namespace --cert "$dir\tls.crt" --key "$dir\tls.key" | Out-Null
    Remove-Item -Recurse -Force $dir
    Write-Host "filevault-tls créé (certificat auto-signé, 365 jours)."
}
