# R-09 : sous charge, le HPA fait passer upload-service de 2 à au moins 4 copies.
# Lève temporairement la limite de dépôts (ES-05), sans quoi la charge ne produirait
# que des refus 429, puis la rétablit. Les fichiers de test expirent après 5 minutes.
# Usage : powershell -ExecutionPolicy Bypass -File scripts\test-charge.ps1 [-Clients 6] [-DureeMax 300]
param([int]$Clients = 6, [int]$DureeMax = 300)

$ErrorActionPreference = 'Continue'
$ns = 'filevault'
$fichier = Join-Path $env:TEMP "filevault-charge-$(Get-Random).bin"
$octets = New-Object byte[] (1024 * 1024)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($octets)
[IO.File]::WriteAllBytes($fichier, $octets)

function Remettre-Limite {
    kubectl -n $ns set env deployment/upload-service UPLOADS_PER_HOUR- | Out-Null
    kubectl -n $ns rollout status deployment upload-service --timeout=180s | Out-Null
    kubectl -n $ns exec redis-0 -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "uploads:*" | xargs -r redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL' | Out-Null
}

$charge = {
    param($fichier, $fin)
    $n = 0; $ok = 0
    while ((Get-Date) -lt $fin) {
        $n++
        $code = curl.exe -sk -m 30 -o NUL -w '%{http_code}' --resolve filevault.local:443:127.0.0.1 -X POST `
            -F duration=5m -F maxDownloads=1 -F "file=@$fichier" https://filevault.local/api/upload
        if ($code -eq '201') { $ok++ }
    }
    "$ok/$n"
}

$jobs = @()
$atteint = $false
try {
    kubectl -n $ns set env deployment/upload-service UPLOADS_PER_HOUR=1000000 | Out-Null
    kubectl -n $ns rollout status deployment upload-service --timeout=180s | Out-Null

    $fin = (Get-Date).AddSeconds($DureeMax)
    $jobs = 1..$Clients | ForEach-Object { Start-Job -ScriptBlock $charge -ArgumentList $fichier, $fin }
    $chrono = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "Charge lancée : $Clients clients, 1 Mo par dépôt."
    while ($chrono.Elapsed.TotalSeconds -lt $DureeMax) {
        Start-Sleep 15
        $etat = kubectl -n $ns get hpa upload-service -o 'jsonpath={.status.currentMetrics[0].resource.current.averageUtilization}|{.status.currentReplicas}|{.status.desiredReplicas}'
        $cpu, $copies, $voulu = $etat -split '\|'
        Write-Host ('{0,4} s  CPU {1,4} %  copies {2} (voulu {3})' -f [int]$chrono.Elapsed.TotalSeconds, $cpu, $copies, $voulu)
        if ([int]$copies -ge 4) { $atteint = $true; break }
    }
} finally {
    $jobs | Stop-Job -ErrorAction SilentlyContinue
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    Remove-Item $fichier -ErrorAction SilentlyContinue
    Remettre-Limite
}

kubectl -n $ns get hpa upload-service
if ($atteint) { Write-Host 'OK     R-09    le HPA a dépassé 4 copies. Limite de dépôts rétablie.'; exit 0 }
Write-Host 'ECHEC  R-09    moins de 4 copies. Limite de dépôts rétablie.'
exit 1
