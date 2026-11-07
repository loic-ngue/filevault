# Recette sur le cluster (section 13) : déroule les critères à travers l'Ingress HTTPS.
# N'exige pas le fichier hosts : curl résout filevault.local vers 127.0.0.1.
# Consomme 3 dépôts sur la limite de 10 par heure et par IP (ES-05).
# Usage : powershell -ExecutionPolicy Bypass -File scripts\recette.ps1 [-AttendreExpiration]
#   -AttendreExpiration : attend aussi la fin d'un lien de 5 minutes et le CronJob (R-04), jusqu'à 11 min.
param([switch]$AttendreExpiration)

$ErrorActionPreference = 'Continue'
$ns = 'filevault'
$base = 'https://filevault.local'
$script:echecs = 0

function Resultat([string]$critere, [bool]$ok, [string]$detail = '') {
    if (-not $ok) { $script:echecs++ }
    Write-Host ('{0,-6} {1,-7} {2}' -f ($(if ($ok) { 'OK' } else { 'ECHEC' })), $critere, $detail)
}
function Https {
    curl.exe -sk -m 60 --resolve filevault.local:443:127.0.0.1 --resolve filevault.local:80:127.0.0.1 @args
}
function Secret([string]$cle) {
    $valeur = kubectl -n $ns get secret filevault-secrets -o "jsonpath={.data.$cle}"
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($valeur))
}
function Deposer([string]$fichier, [string]$duree, [int]$max, [string]$motDePasse) {
    $champs = @('-F', "duration=$duree", '-F', "maxDownloads=$max")
    if ($motDePasse) { $champs += @('-F', "password=$motDePasse") }
    Https -X POST @champs -F "file=@$fichier;type=application/pdf" "$base/api/upload" | ConvertFrom-Json
}
function Telecharger([string]$jeton, [string]$motDePasse, [string]$sortie) {
    Https -X POST -o $sortie -w '%{http_code}' -H 'content-type: application/json' `
        --data-raw ('{\"password\":\"' + $motDePasse + '\"}') "$base/d/$jeton"
}
# Accès direct à MinIO, en contournant FileVault, comme le ferait un voleur du stockage.
function Minio([string]$chemin, [string[]]$options = @()) {
    curl.exe -s -m 20 --aws-sigv4 'aws:amz:us-east-1:s3' --user "$($script:minioUser):$($script:minioPass)" @options "http://127.0.0.1:19000/filevault$chemin"
}
function Objets { ([regex]::Matches((Minio '?list-type=2'), '<Key>([^<]+)</Key>') | ForEach-Object { $_.Groups[1].Value }) }
function Sonde([hashtable]$etiquettes, [string]$cible) {
    $nom = 'recette-reseau-' + (Get-Random -Maximum 99999)
    $labels = ($etiquettes.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ','
    $out = kubectl -n $ns run $nom --rm -i --restart=Never --quiet --image=filevault/link-service:dev --labels=$labels `
        --command -- wget -T 5 -q -O /dev/null -S $cible 2>&1 | Out-String
    $out -match 'HTTP/1\.1 200'
}

$dossier = Join-Path $env:TEMP "filevault-recette-$(Get-Random)"
New-Item -ItemType Directory $dossier | Out-Null
$original = Join-Path $dossier 'contrat.pdf'
$marqueur = 'FILEVAULT-CONTENU-EN-CLAIR-'
$octets = [Text.Encoding]::ASCII.GetBytes($marqueur * 77673)
[IO.File]::WriteAllBytes($original, $octets[0..(2097152 - 1)])
$empreinte = (Get-FileHash $original).Hash

$script:minioUser = Secret 'MINIO_ROOT_USER'
$script:minioPass = Secret 'MINIO_ROOT_PASSWORD'
$pf = Start-Process kubectl -ArgumentList '-n', $ns, 'port-forward', 'pod/minio-0', '19000:9000' -WindowStyle Hidden -PassThru
Start-Sleep 3

try {
    Resultat 'ES-06' ((Https -o NUL -w '%{http_code}' 'http://filevault.local/') -eq '308') 'HTTP redirigé vers HTTPS'

    # Parcours principal
    $avant = @(Objets)
    $lien = Deposer $original '1h' 2 'secret123'
    Resultat 'R-01' ([bool]$lien.token) "fichier de 2 Mo déposé, lien $($lien.path.Substring(0, 9))…"

    $nouveaux = @(Objets | Where-Object { $avant -notcontains $_ })
    Resultat 'R-05' ($nouveaux.Count -eq 1) 'un seul nouvel objet dans MinIO'
    $brut = Join-Path $dossier 'brut.bin'
    Minio "/$($nouveaux[0])" @('-o', $brut)
    $contenu = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($brut))
    Resultat 'R-05' (($contenu.Length -eq 2097152 + 89) -and -not $contenu.Contains($marqueur)) "objet brut illisible, $($contenu.Length) octets"

    $info = Https "$base/api/links/$($lien.token)" | ConvertFrom-Json
    Resultat 'EF-10' (($info.name -eq 'contrat.pdf') -and $info.passwordRequired -and ($info.remainingDownloads -eq 2)) "$($info.name), $($info.size) octets"

    $faux = Join-Path $dossier 'faux.bin'
    Resultat 'EF-08' ((Telecharger $lien.token 'mauvais' $faux) -eq '401') 'mauvais mot de passe refusé'

    foreach ($i in 1, 2) {
        $recu = Join-Path $dossier "recu$i.pdf"
        $code = Telecharger $lien.token 'secret123' $recu
        Resultat 'R-02' (($code -eq '200') -and ((Get-FileHash $recu).Hash -eq $empreinte)) "téléchargement $i identique à l'original (SHA-256)"
    }
    $code = Telecharger $lien.token 'secret123' $faux
    $message = (Get-Content -Raw -Encoding utf8 $faux | ConvertFrom-Json).error
    Resultat 'R-03' (($code -eq '410') -and ($message -match 'Lien expir')) "3e téléchargement : $code, $message"

    # Nettoyage du fichier épuisé (lancé à la main pour ne pas attendre le CronJob)
    $job = 'recette-cleanup-' + (Get-Random -Maximum 99999)
    kubectl -n $ns create job $job --from=cronjob/cleanup | Out-Null
    kubectl -n $ns wait "job/$job" --for=condition=complete --timeout=90s | Out-Null
    Resultat 'EF-07' ((@(Objets) -notcontains $nouveaux[0])) 'fichier épuisé supprimé de MinIO par cleanup'
    kubectl -n $ns delete job $job | Out-Null

    # Blocage du mot de passe
    $lien2 = Deposer $original '1h' 1 'secret123'
    $codes = 1..5 | ForEach-Object { Telecharger $lien2.token 'mauvais' $faux }
    $bloque = Telecharger $lien2.token 'secret123' $faux
    Resultat 'R-06' (($codes[3] -eq '401') -and ($codes[4] -eq '429') -and ($bloque -eq '429')) "codes $($codes -join ','), puis bon mot de passe : $bloque"

    # Révocation et persistance après redémarrage du stockage
    $lien3 = Deposer $original '1h' 3 ''
    kubectl -n $ns delete pod redis-0 minio-0 | Out-Null
    Stop-Process -Id $pf.Id -ErrorAction SilentlyContinue
    Start-Sleep 5
    kubectl -n $ns wait pod/redis-0 pod/minio-0 --for=condition=Ready --timeout=120s | Out-Null
    kubectl -n $ns wait pod -l app=upload-service --for=condition=Ready --timeout=60s | Out-Null
    kubectl -n $ns wait pod -l app=download-service --for=condition=Ready --timeout=60s | Out-Null
    $pf = Start-Process kubectl -ArgumentList '-n', $ns, 'port-forward', 'pod/minio-0', '19000:9000' -WindowStyle Hidden -PassThru
    Start-Sleep 3
    $recu = Join-Path $dossier 'persistant.pdf'
    $code = Telecharger $lien3.token '' $recu
    Resultat 'Persist.' (($code -eq '200') -and ((Get-FileHash $recu).Hash -eq $empreinte)) 'lien et fichier conservés après redémarrage de Redis et MinIO'

    $code = Https -X POST -o NUL -w '%{http_code}' -H 'content-type: application/json' --data-raw ('{\"revokeCode\":\"' + $lien3.revokeCode + '\"}') "$base/api/links/$($lien3.token)/revoke"
    Resultat 'EF-09' (($code -eq '204') -and ((Telecharger $lien3.token '' $faux) -eq '410')) 'lien révoqué, puis refusé'

    $stats = Https -H "authorization: Bearer $(Secret 'ADMIN_TOKEN')" "$base/api/links/stats" | ConvertFrom-Json
    Resultat 'EF-11' ($stats.downloads -ge 3) "$($stats.activeFiles) fichier(s) actif(s), $($stats.downloads) téléchargement(s)"

    # Auto-réparation
    $pod = (kubectl -n $ns get pods -l app=link-service -o name | Select-Object -First 1)
    $chrono = [Diagnostics.Stopwatch]::StartNew()
    kubectl -n $ns delete $pod --wait=false | Out-Null
    $coupures = 0
    do {
        if ((Https -o NUL -w '%{http_code}' "$base/api/links/inconnu") -ne '410') { $coupures++ }
        $prets = (kubectl -n $ns get deployment link-service -o 'jsonpath={.status.readyReplicas}')
    } while (($prets -ne '2' -or $chrono.Elapsed.TotalSeconds -lt 2) -and $chrono.Elapsed.TotalSeconds -lt 60)
    Resultat 'R-08' (($chrono.Elapsed.TotalSeconds -lt 30) -and ($coupures -eq 0)) "pod recréé en $([int]$chrono.Elapsed.TotalSeconds) s, $coupures requête(s) en échec"

    # Mise à jour progressive sans coupure
    kubectl -n $ns rollout restart deployment link-service | Out-Null
    $coupures = 0; $total = 0; $chrono.Restart()
    do {
        $total++
        if ((Https -o NUL -w '%{http_code}' "$base/api/links/inconnu") -ne '410') { $coupures++ }
        $fini = (kubectl -n $ns get deployment link-service -o 'jsonpath={.status.updatedReplicas}/{.status.readyReplicas}/{.status.replicas}')
    } while ($fini -ne '2/2/2' -and $chrono.Elapsed.TotalSeconds -lt 120)
    Resultat 'R-07' ($coupures -eq 0) "mise à jour progressive : $total requêtes, $coupures en échec (partie déploiement seulement, sans le pipeline)"

    # Version défectueuse puis retour arrière (sans ArgoCD, qui annulerait le rollout undo)
    $imageAvant = kubectl -n $ns get deployment link-service -o 'jsonpath={.spec.template.spec.containers[0].image}'
    kubectl -n $ns set image deployment/link-service link-service=filevault/link-service:inexistante | Out-Null
    Start-Sleep 10
    $pendant = Https -o NUL -w '%{http_code}' "$base/api/links/inconnu"
    kubectl -n $ns rollout undo deployment link-service | Out-Null
    kubectl -n $ns rollout status deployment link-service --timeout=120s | Out-Null
    $imageApres = kubectl -n $ns get deployment link-service -o 'jsonpath={.spec.template.spec.containers[0].image}'
    Resultat 'R-10' (($pendant -eq '410') -and ($imageApres -eq $imageAvant)) "version défectueuse sans effet sur le service ($pendant), annulée par rollout undo"

    # Isolation réseau
    Resultat 'ES-08' (Sonde @{ app = 'upload-service' } 'http://minio:9000/minio/health/live') 'pod autorisé : joint MinIO'
    Resultat 'ES-08' (-not (Sonde @{ app = 'pirate' } 'http://minio:9000/minio/health/live')) 'pod non autorisé : ne joint pas MinIO'

    # Expiration réelle
    if ($AttendreExpiration) {
        $avant = @(Objets)
        $lien4 = Deposer $original '5m' 2 ''
        $id = @(Objets | Where-Object { $avant -notcontains $_ })[0]
        Write-Host 'Attente de 5 min 10 s pour R-04…'
        Start-Sleep 310
        Resultat 'R-04' ((Telecharger $lien4.token '' $faux) -eq '410') 'lien refusé après 5 minutes'
        $chrono.Restart()
        while ((@(Objets) -contains $id) -and $chrono.Elapsed.TotalSeconds -lt 330) { Start-Sleep 10 }
        Resultat 'R-04' (@(Objets) -notcontains $id) "fichier supprimé de MinIO par le CronJob, $([int]$chrono.Elapsed.TotalSeconds) s plus tard"
    }
} catch {
    # Une erreur inattendue ne doit jamais passer pour une réussite.
    $script:echecs++
    Write-Host "ECHEC  arrêt inattendu : $_"
} finally {
    Stop-Process -Id $pf.Id -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $dossier
}

Write-Host ''
if ($script:echecs -eq 0) { Write-Host 'Recette réussie.' } else { Write-Host "$($script:echecs) critère(s) en échec." }
exit $script:echecs
