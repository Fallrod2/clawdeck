# clawdeck

Dashboard temps réel self-hosted pour superviser une instance OpenClaw locale
(agent Codex primary, fallback Ollama, canal WhatsApp) depuis un Mac mini
headless, accessible uniquement via Tailscale.

Voir `CLAUDE.md` pour le contexte complet et les règles d'architecture.

## Stack

- **Backend** : Bun + Hono (TypeScript) — sert aussi le front buildé
- **Front** : React + Vite + Tailwind (thème sombre), dans `/web`
- **Temps réel** : SSE pour les statuts (`/api/status`)
- **Persistance** : SQLite (`bun:sqlite`) — historique des pings uniquement
- **Réseau** : bind sur 127.0.0.1 ou une IP Tailscale, jamais `0.0.0.0`

## État actuel

Phase 1 (MVP) en place : health panel avec statut de la gateway OpenClaw,
d'Ollama (et de son modèle de fallback), pings vers Cloudflare et la
passerelle réseau, graphe de latence 24h/7j. Le chat (phase 2) n'est pas
encore implémenté.

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
- `BIND_HOST` — `127.0.0.1` en local, ou l'IP Tailscale du Mac mini
  (`tailscale ip -4`) pour un accès distant

## Développement

```bash
bun run dev
```

Lance le backend (`--watch`) et le serveur Vite en parallèle. Le front dev
(`localhost:5173`) proxifie `/api` vers le backend (`localhost:3001`).

Le serveur dev Vite n'écoute que sur `localhost` — pour tester l'accès
réseau (Tailscale), utiliser le build de prod (voir ci-dessous).

## Build & production

```bash
bun run build   # build le front dans web/dist
bun run start   # sert l'API + le front buildé sur BIND_HOST:PORT
```

Le dashboard est alors accessible à `http://<BIND_HOST>:<PORT>` (token
requis, saisi une fois puis stocké côté navigateur).

## Structure

```
src/            backend Hono (env, checks HTTP, ping système, SQLite, SSE)
web/src/        front React (composants, hooks SSE/historique)
dev.ts          orchestrateur dev (backend + front en parallèle)
```
