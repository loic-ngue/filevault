# Preuves d'exécution

Collectées le 7 novembre 2026 sur le cluster Kubernetes local (Docker Desktop, un nœud), avec ArgoCD v3.6.1 et le dépôt [loic-ngue/filevault](https://github.com/loic-ngue/filevault). Les fichiers `.txt` se régénèrent avec `scripts/collecter-preuves.ps1` ; chacun indique sa date et les commandes exactes qui l'ont produit.

## Livrables demandés (section 11 du cahier des charges)

| Preuve demandée | Fichiers | Ce qu'on y voit |
| --- | --- | --- |
| Pipeline vert | `09-pipeline-vert.jpg`, `04-pipeline.txt` | test (5 jobs) → build, scan, publication (5 jobs) → mise à jour de `k8s/`, en 1 min 28 s |
| `kubectl get pods` | `01-cluster.txt`, `14-securite-conteneurs.png` | 4 Deployments à 2 copies (upload jusqu'à 5 sous charge), Redis et MinIO, CronJob, HPA, Ingress |
| HPA | `13-hpa-montee-en-charge.png`, `07-hpa-charge.txt` | upload-service passe de 2 à 3 puis 5 copies en 63 s sous charge |
| Rollback | `08-rollback.txt`, `12-recette-cluster.png` (ligne R-10) | une version défectueuse n'interrompt pas le service, puis `rollout undo` restaure la précédente |
| Application dans le navigateur | à faire | nécessite la ligne `127.0.0.1 filevault.local` dans le fichier hosts |

## Autres preuves

| Fichier | Critère | Contenu |
| --- | --- | --- |
| `12-recette-cluster.png`, `06-recette.txt` | R-01 à R-10, ES-06, ES-08 | 19 vérifications à travers l'Ingress HTTPS, toutes réussies |
| `18-argocd-vue-reseau.png` | étape 8, section 9 | interface ArgoCD : Ingress → 4 Services → 2 pods chacun, MinIO, Redis, CronJob ; `Healthy`, `Synced`, synchronisation automatique active |
| `17-argocd-historique.png` | étape 8, R-10 | déploiements appliqués par « automated sync policy » depuis les commits « Déploie … » de `github-actions[bot]`, en 5 à 20 s ; chacun peut servir de point de retour arrière |
| `16-argocd-applications.png` | étape 8 | application `filevault` liée au dépôt GitHub, branche `main`, dossier `k8s` |
| `03-argocd.txt` | étape 8 | application `Synced / Healthy`, historique des 3 déploiements GitOps |
| `10-historique-pipelines.jpg` | section 8 | les 5 exécutions du pipeline, dont une en échec |
| `11-trivy-bloque-le-deploiement.jpg` | ES-10 | Trivy bloque le déploiement : 5 images avec failles critiques, mise à jour de `k8s/` non exécutée |
| `15-trivy-images-production.png`, `05-trivy-images-deployees.txt` | ES-10 | après correction (Node 24, images sans npm), aucune faille critique dans les images en production |
| `14-securite-conteneurs.png`, `02-securite-conteneurs.txt` | ES-09 | les 15 pods : non root, système de fichiers en lecture seule, sans escalade, capacités retirées |

## Mesure R-07 : du `git push` à la production

Mesurée avec `scripts/suivi-deploiement.ps1` sur le commit `45bf3a2` :

| Temps | Étape |
| --- | --- |
| 0 s | `git push` |
| 91 s | pipeline vert |
| 92 s | commit de déploiement `e93dbe2`, appliqué par ArgoCD |
| 145 s | les 4 Deployments tournent la nouvelle image |

58 requêtes envoyées à l'application pendant l'opération, aucune en échec.

## Ouvrir l'interface ArgoCD

`scripts/argocd-ui.ps1` ouvre https://localhost:8443 et relance le tunnel si le pod redémarre. `scripts/argocd-mot-de-passe.ps1` affiche les identifiants (utilisateur `admin`).

## À compléter

- **Application dans le navigateur**, une fois `127.0.0.1 filevault.local` ajouté au fichier hosts.
