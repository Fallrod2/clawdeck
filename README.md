# clawdeck

Dashboard temps réel self-hosted pour superviser une instance OpenClaw locale
(agent Codex primary, fallback Ollama, canal WhatsApp) depuis un Mac mini
headless, accessible uniquement via Tailscale.

Voir `CLAUDE.md` pour le contexte complet et les règles d'architecture.
Les règles visuelles et d'interaction sont dans `docs/UI_UX.md`.

## Stack

- **Backend** : Bun + Hono (TypeScript) — sert aussi le front buildé
- **Front** : React + Vite + Tailwind (thème sombre), dans `/web`
- **Temps réel** : SSE pour les statuts (`/api/status`), WebSocket relayé pour le chat (`/api/chat/ws`)
- **Persistance** : SQLite (`bun:sqlite`) — historique des pings uniquement (le chat n'est jamais dupliqué, voir `chat.history` de la gateway)
- **Réseau** : bind sur 127.0.0.1 ou une IP Tailscale, jamais `0.0.0.0`

## État actuel

Phase 1 (health panel) et phase 2 (chat) en place :
- Statut HTTP + RPC de la gateway OpenClaw, provider/modèle réellement actif,
  état WhatsApp, Ollama et son modèle de fallback, pings vers Cloudflare, la
  passerelle réseau et un site distant (83.204.110.38), graphe de latence 24h/7j.
- Tail SSE des logs OpenClaw via `logs.tail`, filtré par la gateway, borné en
  mémoire et jamais persisté par clawdeck.
- Chat riche : le backend maintient une connexion WS authentifiée par
  identité d'appareil vers la gateway OpenClaw (`src/gateway/`) et la relaie
  au front (markdown, tool calls visibles, streaming). Voir
  `docs/gateway/protocol.md` du paquet `openclaw` pour le protocole complet.

## Prérequis

- [Bun](https://bun.sh) ≥ 1.3
- Une instance OpenClaw qui tourne déjà sur la machine (pour connaître son
  `GATEWAY_URL`, ex. `ps aux | grep openclaw`)
- [Tailscale](https://tailscale.com) installé et connecté si tu veux accéder
  au dashboard depuis un autre appareil

## Installation

```bash
bun install
bun install --cwd web

cp .env.example .env
```

Éditer `.env` :
- `AUTH_TOKEN` — génère une valeur aléatoire (`openssl rand -hex 32`)
- `GATEWAY_URL` — URL de la gateway OpenClaw locale (ex. `http://127.0.0.1:18789`)
- `GATEWAY_AUTH_TOKEN` — le `gateway.auth.token` de `~/.openclaw/openclaw.json`
  (nécessaire pour le chat, distinct d'`AUTH_TOKEN`)
- `BIND_HOST` — `127.0.0.1` en local, ou l'IP Tailscale du Mac mini
  (`tailscale ip -4`) pour un accès distant

Le premier démarrage crée une identité d'appareil Ed25519
(`data/gateway-device-identity.json`, non commitée) pour s'authentifier
auprès de la gateway OpenClaw — rien à faire manuellement, mais si ce
fichier est supprimé la gateway le traitera comme un nouvel appareil.

## Développement

```bash
bun run dev
```

Lance le backend (`--watch`) et le serveur Vite en parallèle. Le front dev
(`localhost:5173`) proxifie `/api` vers le backend (`localhost:3001`).

Le serveur dev Vite n'écoute que sur `localhost` — pour tester l'accès
réseau (Tailscale), utiliser le build de prod (voir ci-dessous).

## Vérifications

```bash
bun run test       # tests unitaires Bun
bun run typecheck  # backend + frontend
bun run lint       # frontend
bun run check      # tous les checks puis le build de production
```

## Build & production

```bash
bun run build   # build le front dans web/dist
bun run start   # sert l'API + le front buildé sur BIND_HOST:PORT
```

Le dashboard est alors accessible à `http://<BIND_HOST>:<PORT>` (token
requis, saisi une fois puis stocké côté navigateur).

## Service permanent (launchd)

Pour que le dashboard tourne en continu, indépendamment de toute session
ouverte (utile avec FileVault activé, qui bloque l'auto-login) :
`launchd/com.clawdeck.server.plist` définit un `LaunchDaemon` système qui
lance le backend au boot avec les droits de l'utilisateur `claw`, et le
relance automatiquement en cas de crash. Les chemins qu'il contient sont
propres à cette machine (Mac mini, utilisateur `claw`) — à adapter pour un
autre déploiement.

```bash
bun run build                        # le daemon sert web/dist
sudo scripts/install-launchd.sh     # vérifie .env + build, installe, démarre
```

Le script est idempotent (mise à jour = même commande) et refuse d'installer
si `.env` est absent/invalide ou si le build manque — la validation
d'environnement du backend est exécutée avant tout changement système, pour
ne jamais installer un daemon qui boucle en crash au boot (le plist a aussi
un `ThrottleInterval` de 15 s en garde-fou).

Logs : `~/Library/Logs/clawdeck/{stdout,stderr}.log`.
Statut : `launchctl print system/com.clawdeck.server`.
Arrêt : `sudo launchctl bootout system/com.clawdeck.server`.
Rollback : `bootout`, restaurer l'ancien plist (ou `git checkout` puis
réinstaller), relancer le script.

## Dépannage

- **`/api/status` renvoie `{"error":"unauthorized"}` en l'ouvrant directement
  dans le navigateur** : normal, ce n'est pas un bug. Une navigation classique
  n'envoie pas le header `Authorization`, seul le `fetch()` du front le fait.
  Il faut passer par `/` (la page du dashboard), pas par l'endpoint API.
- **Toutes les cartes restent sur "En attente…" / "déconnecté" alors que le
  backend répond bien en `curl`** : le token stocké côté navigateur est
  probablement incorrect (mauvais copier-coller). Vérifier dans la console :
  `localStorage.getItem("clawdeck.token")` — doit renvoyer exactement la
  valeur d'`AUTH_TOKEN`, rien d'autre. Sinon : `localStorage.removeItem("clawdeck.token")`
  puis recharger et recoller le bon token.

## Structure

```
src/            backend Hono (collecteurs statut/logs, checks, ping, SQLite, SSE)
src/gateway/    client WS vers la gateway OpenClaw (auth device, chat)
web/src/        front React (composants, hooks SSE/historique/chat)
docs/           règles produit et UI/UX durables
dev.ts          orchestrateur dev (backend + front en parallèle)
launchd/        service système (LaunchDaemon) pour un fonctionnement permanent
```
