# Deployment Tracker

Synchronise les déploiements **Dokploy** avec le journal **GitHub Deployments**. Service léger en Node.js 24 et Fastify, déployable sur un VPS.

```text
Notification Dokploy → Deployment Tracker → GitHub Deployments
```

Le service conserve le commit, le résultat et les dates Dokploy de chaque déploiement. API et frontend peuvent partager un environnement (`staging`, `test`, `preprod`) tout en gardant leurs entrées distinctes : `deploy:api` et `deploy:web`.

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
| `SYNC_INTERVAL_SECONDS` | Intervalle de rattrapage, `300` par défaut ; `0` désactive le timer |

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

Ajouter `--dry-run` à une commande pour la simuler. `DRY_RUN=true` dans `.env` impose aussi la simulation. Les imports existants sont reconnus pour éviter les doublons. Le filtre `--since` utilise la date de fin Dokploy, ou la date de création si elle manque.

> [!IMPORTANT]
> Le serveur synchronise tout l’historique disponible au démarrage, puis à chaque notification et toutes les cinq minutes. Arrêter le serveur avant un import manuel : une seule instance doit utiliser le fichier d’état.

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

## À savoir

- Seul l’historique encore conservé dans Dokploy est récupérable. Les previews, déploiements non terminés et entrées sans commit exact sont ignorés.
- GitHub affiche la date d’import. Les dates d’origine restent dans `payload.dokployCreatedAt` et `payload.dokployFinishedAt` : utiliser ces dates pour les bilans mensuels.
- `success` correspond au résultat Dokploy, sans contrôle supplémentaire de santé de l’application. Le service ne gère pas la désactivation des anciennes entrées GitHub.
- Le rapprochement automatique avec les PR et issues et la génération du PV mensuel ne sont pas encore implémentés.
- Conserver les secrets dans `.env` ou les variables Dokploy ; `.env` et `data/` sont exclus de Git et de l’image Docker.
