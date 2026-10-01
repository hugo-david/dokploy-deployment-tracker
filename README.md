# Deployment Tracker

Synchronise les déploiements **Dokploy** avec le journal **GitHub Deployments**. Service léger en Node.js 24 et Fastify, déployable sur un VPS.

```text
Notification Dokploy → Deployment Tracker → GitHub Deployments
```

Le service conserve le commit, le résultat et les dates Dokploy de chaque déploiement. API et frontend partagent une seule entrée par **environnement et commit** (`staging`, `test`, `preprod`). Un redéploiement du même commit met à jour le résultat de cette entrée.

## Installation

Prérequis : **Node.js 24** et **pnpm 10**.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
cp config.example.json config.json
openssl rand -hex 32
```

Utiliser la clé générée comme `WEBHOOK_SECRET`, puis renseigner `.env` :

| Variable | Usage |
| --- | --- |
| `DOKPLOY_URL` | URL de l’instance Dokploy |
| `DOKPLOY_API_KEY` | Accès aux historiques des services suivis |
| `GITHUB_TOKEN` | Token du dépôt cible, **Deployments → Read and write** |
| `WEBHOOK_SECRET` | Secret partagé avec la notification Dokploy |
| `DRY_RUN` | `true` pour simuler, `false` pour écrire dans GitHub |
| `SYNC_INTERVAL_SECONDS` | Intervalle de rattrapage, `86400` par défaut ; `0` désactive le timer |

Dans `config.json`, déclarer les services à suivre :

```json
{
  "targets": [
    {
      "type": "application",
      "id": "ID_APPLICATION_DOKPLOY",
      "service": "api",
      "repository": "owner/repository",
      "environment": "test",
      "environmentUrl": "https://api.example.com"
    }
  ]
}
```

`type` accepte `application` ou `compose` ; `id` correspond à l’identifiant Dokploy. `environmentUrl` est facultatif. Ajouter `production: true` pour la production. Chaque cible doit avoir un identifiant distinct et une combinaison dépôt/environnement/service unique. Ne pas inclure Deployment Tracker lui-même.

## Synchronisation

```bash
# Vérifier la syntaxe et simuler l’import
pnpm check
pnpm sync --dry-run

# Importer depuis une date
pnpm sync --since 2026-09-01

# Importer un seul déploiement Dokploy
pnpm sync --target ID_APPLICATION_DOKPLOY --deployment ID_DEPLOIEMENT_DOKPLOY

# Démarrer le serveur sur le port 3000
pnpm start
```

Ajouter `--dry-run` à une commande pour la simuler. `DRY_RUN=true` dans `.env` impose aussi la simulation. Les imports existants sont reconnus pour éviter les doublons. Le filtre `--since` utilise la dernière date de fin du groupe, ou la date de création si elle manque. `--target` sélectionne l’environnement complet du service ; `--deployment` limite au commit de cette tentative, en consultant aussi les autres services attendus.

> [!IMPORTANT]
> Le serveur synchronise tout l’historique disponible au démarrage, puis à chaque notification et toutes les 24 heures par défaut. Arrêter le serveur avant un import manuel : une seule instance doit utiliser le fichier d’état.

## Notification Dokploy

Dans **Settings → Notifications → Custom**, configurer :

| Champ | Valeur |
| --- | --- |
| Webhook URL | `https://tracker.example.com/webhooks/dokploy` |
| Header | `Authorization: Bearer <WEBHOOK_SECRET>` |
| Actions | **App Deploy** et **App Build Error** |

**Test Notification** vérifie la réception sans lancer d’import. Les notifications `type=build` et `status=success/error` déclenchent une lecture de l’historique Dokploy ; le rattrapage périodique couvre les notifications manquées.

Pour tester localement : `ngrok http 3000`, puis utiliser l’URL du tunnel suivie de `/webhooks/dokploy`.

## Déploiement sur le VPS

Après configuration, passer à `DRY_RUN=false` :

```bash
docker compose up -d --build
docker compose logs -f tracker
```

Le fichier Compose monte `config.json` et un volume persistant pour l’état. Son port est publié sur `127.0.0.1:3000` ; le rendre accessible via un reverse proxy HTTPS.

Pour une **Application Dokploy**, construire le Dockerfile, fournir les variables d’environnement, monter `config.json` sur `/app/config.json` et un volume sur `/app/data`, inscriptible par l’utilisateur Node (UID 1000). Configurer le domaine sur le port interne **3000** et mettre à jour l’URL de notification. `.env` et la configuration ne sont pas inclus dans l’image.

`GET /health` vérifie que le serveur écoute. Les résultats et erreurs de synchronisation sont disponibles dans les logs.

## Résultats regroupés

- **Succès** : la dernière tentative de chaque service configuré pour ce commit a réussi.
- **Échec** : au moins un service a échoué ou a été annulé, même si un autre manque encore.
- **Aucun résultat intermédiaire** : tant que le groupe est incomplet ou qu’un service est en cours sans échec, aucune nouvelle entrée ni statut n’est publié. Lors d’une nouvelle tentative, le dernier résultat final reste affiché jusqu’au suivant.

La dernière tentative de chaque service est conservée dans le volume, y compris les tentatives en cours, pour éviter de reprendre un ancien succès après un échec ou pendant un redéploiement. Un groupe est défini par les services du même dépôt et environnement dans `config.json` : déclarer seulement les services réellement attendus pour cette livraison.

GitHub conserve les résultats successifs comme statuts de **la même entrée**. Les logs distinguent `created`, `updated`, `recovered` et `unchanged` ; `waiting` compte les groupes sans résultat final et `failed` les erreurs de synchronisation.

## Compatibilité et limites

- L’ancien fichier d’état est migré automatiquement et sauvegardé dans `data/state.json.v1.bak` avant toute écriture. Pour un commit déjà enregistré, le script reprend une entrée existante, sans créer une troisième ligne. Les anciennes lignes séparées restent dans le journal ; cette version ne les supprime pas.
- Une seule instance doit fonctionner à la fois. Dans Dokploy Swarm, utiliser une mise à jour **stop-first** pour éviter un chevauchement de l’ancienne et de la nouvelle instance pendant le déploiement.
- Seul l’historique encore conservé dans Dokploy ou le volume local est récupérable. Les previews et entrées sans commit exact sont ignorées.
- GitHub affiche la date d’import. Le `payload` conserve les services et dates à la création de l’entrée et ne peut pas être modifié ; après un redéploiement, utiliser les descriptions des statuts et `data/state.json` pour les résultats et dates actualisés. Une entrée héritée conserve son ancien `payload` par service.
- `success` correspond au résultat Dokploy, sans contrôle supplémentaire de santé de l’application. Le service ne gère pas la désactivation des anciennes entrées GitHub.
- Le rapprochement automatique avec les PR et issues et la génération du PV mensuel ne sont pas encore implémentés.
- Conserver les secrets dans `.env` ou les variables Dokploy ; `.env` et `data/` sont exclus de Git et de l’image Docker.
