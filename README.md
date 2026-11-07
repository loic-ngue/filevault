# FileVault

Partage de fichiers chiffrés par lien temporaire, en micro-services Node.js, livré par GitHub Actions et déployé sur Kubernetes. Le cahier des charges complet est dans le document « FileVault — Cahier des charges ».

## Structure

| Dossier | Rôle | État |
| --- | --- | --- |
| `services/link-service` | Liens : création, consultation, décompte, mot de passe, révocation, statistiques | fait, testé |
| `services/cleanup` | CronJob : suppression des fichiers expirés dans MinIO | fait, testé |
| `services/upload-service` | Dépôt en flux, chiffrement AES-256-GCM, limite de dépôts par IP | fait, testé |
| `services/download-service` | Déchiffrement en flux et téléchargement | fait, testé |
| `services/frontend` | Interface en français : dépôt, page destinataire, administration (Nginx non root) | fait, testé |
| `docker/gateway.conf` | Passerelle docker-compose, même routage que l'Ingress | fait |
| `scripts/dev-sans-docker.js` | Tous les services dans un processus, Redis et MinIO simulés | fait |
| `k8s/` | Manifestes Kubernetes (Kustomize) : tous les objets de la section 9 | déployé et recetté |
| `argocd/application.yaml` | Application GitOps | écrit, adresse du dépôt à renseigner |
| `scripts/creer-secrets.ps1`, `scripts/deployer-local.ps1` | Secrets hors de Git, déploiement manuel | utilisés sur le cluster |
| `scripts/recette.ps1`, `scripts/test-charge.ps1` | Critères de recette sur le cluster, test de charge du HPA | utilisés sur le cluster |
| `.github/workflows/ci-cd.yml` | Pipeline : lint, tests, build | partie CI |

## Lancer les tests d'un service

```bash
cd services/link-service
npm install
npm run lint
npm test
```

## Lancer en local

```bash
cp .env.example .env
docker compose up --build
```

Tout passe par la passerelle sur http://localhost:8080, routée comme l'Ingress : `/api/upload`, `/api/links`, `/d/`, puis le frontend. Les services restent joignables en direct sur les ports 3001 à 3003 pour les tests.

## Déployer sur Kubernetes

Tout tourne dans le namespace `filevault`. Les manifestes sont rassemblés par [k8s/kustomization.yaml](k8s/kustomization.yaml).

| Fichier | Objets |
| --- | --- |
| `config.yaml` | ConfigMaps `filevault-config` et `frontend-config` (durées, limites) |
| `redis.yaml`, `minio.yaml` | StatefulSets avec volumes de 1 Gi et 5 Gi |
| `link-service.yaml`, `frontend.yaml` | Deployments à 2 copies |
| `upload-service.yaml`, `download-service.yaml` | Deployments à 2–6 copies selon le HPA |
| `autoscaling.yaml` | HPA upload et download, seuil 70 % CPU |
| `cleanup.yaml` | CronJob toutes les 5 minutes |
| `ingress.yaml` | HTTPS sur `filevault.local`, routage par chemin, 51 Mo max |
| `network-policies.yaml` | refus par défaut, puis seuls les chemins autorisés |

Tous les conteneurs tournent sans root, avec un système de fichiers en lecture seule et sans capacités Linux. Les Deployments font des mises à jour progressives avec `maxUnavailable: 0`.

### Prérequis du cluster (une fois)

1. Docker Desktop avec Kubernetes activé.
2. Le contrôleur Ingress NGINX :

    ```bash
    kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/cloud/deploy.yaml
    ```

3. metrics-server, pour le HPA. En local, il faut lui ajouter l'option `--kubelet-insecure-tls` :

    ```bash
    kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
    ```

    ```bash
    kubectl -n kube-system patch deployment metrics-server --type=json -p "[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"--kubelet-insecure-tls\"}]"
    ```

4. Dans `C:\Windows\System32\drivers\etc\hosts`, en administrateur : `127.0.0.1 filevault.local`.

### Déploiement manuel

```bash
powershell -ExecutionPolicy Bypass -File scripts/creer-secrets.ps1
```

```bash
powershell -ExecutionPolicy Bypass -File scripts/deployer-local.ps1
```

Le premier script crée la clé maître, les jetons, les mots de passe Redis et MinIO et le certificat TLS, sans rien écrire dans le dépôt. Il ne remplace jamais un secret existant, et garde une copie dans `%USERPROFILE%\filevault-secrets.txt`. Le second construit les images, les charge dans le cluster et applique `k8s/`. L'application répond ensuite sur https://filevault.local (certificat auto-signé à accepter).

### Vérifier le déploiement

```bash
powershell -ExecutionPolicy Bypass -File scripts/recette.ps1
```

```bash
powershell -ExecutionPolicy Bypass -File scripts/test-charge.ps1
```

Le premier script déroule les critères de recette à travers l'Ingress, et n'exige pas le fichier hosts. L'option `-AttendreExpiration` ajoute R-04, jusqu'à 11 minutes d'attente. Il consomme 3 ou 4 dépôts sur la limite de 10 par heure. Le second charge upload-service jusqu'à ce que le HPA dépasse 4 copies (R-09).

Chaque service expose deux sondes : `/live` (le processus répond, sonde de vie) et `/health` (ses dépendances répondent, sonde de disponibilité). Si MinIO ou Redis tombe, les pods cessent de recevoir du trafic sans être redémarrés en boucle.

L'image MinIO vient de `cgr.dev/chainguard/minio`, épinglée par empreinte : le dépôt `minio/minio` de Docker Hub n'est plus accessible sans compte.

### Avec ArgoCD

Renseigner l'adresse du dépôt dans [argocd/application.yaml](argocd/application.yaml), installer ArgoCD (commandes en tête du fichier), puis `kubectl apply -f argocd/application.yaml`. ArgoCD synchronise `k8s/` à chaque commit et annule toute modification faite à la main. Pour la recette R-10, le retour arrière se fait donc par un `git revert` ou depuis l'interface d'ArgoCD, pas par `kubectl rollout undo`, qu'ArgoCD effacerait aussitôt.

## Lancer sans Docker (démo rapide)

Après `npm install` dans chaque dossier de `services/` :

```bash
node scripts/dev-sans-docker.js
```

L'application complète tourne sur http://localhost:8080, avec une durée de 5 minutes en plus pour les recettes R-01 et R-04. Le jeton administrateur est `admin-dev`. Redis est simulé et MinIO est remplacé par la mémoire : tout est perdu à l'arrêt.

## Frontend

| Adresse | Page |
| --- | --- |
| `/` | dépôt par glisser-déposer, durée, limite, mot de passe ; lien avec bouton Copier et code de révocation |
| `/d/<jeton>` | lien partagé : redirige vers `/#/d/<jeton>`, qui affiche nom, taille, temps restant et téléchargements restants |
| `/#/admin` | statistiques, avec le jeton administrateur |

Les durées proposées et les limites viennent de `/config.json`, remplaçable par une ConfigMap Kubernetes.

## API de link-service

| Méthode et chemin | Accès | Rôle |
| --- | --- | --- |
| `POST /api/links` | interne (`Authorization: Bearer $INTERNAL_TOKEN`) | crée un lien après le dépôt du fichier |
| `GET /api/links/:token` | public | nom, taille, temps restant, mot de passe requis |
| `POST /api/links/:token/consume` | interne | vérifie le mot de passe, décompte un téléchargement |
| `POST /api/links/:token/revoke` | public, avec `revokeCode` | révoque le lien |
| `GET /api/links/stats` | admin (`Authorization: Bearer $ADMIN_TOKEN`) | fichiers actifs, volume, téléchargements |
| `GET /health`, `GET /metrics` | cluster | probes Kubernetes, Prometheus |

## API de upload-service

`POST /api/upload` en `multipart/form-data`. Les champs `duration`, `maxDownloads` et `password` (facultatif) doivent précéder le champ `file`.

```bash
curl -F duration=1h -F maxDownloads=3 -F file=@contrat.pdf http://localhost:3002/api/upload
```

Réponse `201` : `token`, `revokeCode`, `expiresAt`, `maxDownloads` et `path` (`/d/<token>`). Erreurs : `400` (formulaire), `413` (plus de 50 Mo), `429` (plus de 10 dépôts par heure et par IP), `502` (MinIO ou link-service indisponible). Après un échec, aucun objet ne reste dans MinIO.

## API de download-service

| Méthode et chemin | Rôle |
| --- | --- |
| `GET /d/:token` | lien partagé : redirige vers `/#/d/<token>` (page du frontend), sans rien décompter |
| `POST /d/:token` | champ `password` facultatif (formulaire ou JSON) : décompte un téléchargement et renvoie le fichier déchiffré |

Le `GET` ne télécharge rien, car les aperçus de lien de WhatsApp ou des messageries ouvrent les URL et videraient le compteur. Le fichier part en pièce jointe, avec son nom et son type d'origine, et avec `Content-Security-Policy: sandbox` pour qu'un fichier HTML déposé ne s'exécute pas. Si le contenu stocké a été altéré, la connexion est coupée avant la fin : le navigateur voit un téléchargement incomplet, pas un fichier faux.

Erreurs : `401` (mot de passe), `410` (lien expiré, épuisé, révoqué ou inconnu), `429` (trop d'essais), `502` (service indisponible). Un formulaire du navigateur reçoit une page HTML, un appel `fetch` reçoit du JSON.

## Format des objets chiffrés

Chaque fichier a sa propre clé AES-256, chiffrée par la clé maître (`MASTER_KEY`). L'identifiant du fichier sert de données authentifiées : un objet recopié sous un autre nom ne se déchiffre pas. Le module `src/crypto.js` est identique dans upload-service et download-service : toute modification doit être reportée dans les deux.

| Octets | Contenu |
| --- | --- |
| 1 | version du format (1) |
| 60 | clé du fichier chiffrée : IV (12) + clé (32) + tag (16) |
| 12 | IV du fichier |
| n | contenu chiffré |
| 16 | tag d'authentification GCM |

## Modèle de données Redis

Le jeton n'est jamais stocké : seule son empreinte SHA-256 sert de clé.

| Clé | Type | Rôle |
| --- | --- | --- |
| `link:<sha256(jeton)>` | hash, TTL = durée | le lien |
| `attempts:<sha256(jeton)>` | compteur, TTL 15 min | essais de mot de passe ratés |
| `expirations` | sorted set | fileId → date de suppression, lu par cleanup |
| `sizes` | hash | fileId → taille, pour les statistiques |
| `stats:downloads` | compteur | téléchargements totaux |
| `uploads:<ip>` | compteur, TTL 1 h | dépôts par adresse IP (upload-service) |
