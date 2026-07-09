# clawdeck — Dashboard temps réel pour OpenClaw

## Contexte
Dashboard web self-hosted sur un Mac mini headless (accès via Tailscale
uniquement). Il observe et pilote une instance OpenClaw locale
(agent : Codex primary, fallback Ollama qwen3.5:9b, canal WhatsApp).

## Stack
- Backend : Bun + Hono (TypeScript), sert aussi le front buildé
- Front : React + Vite + Tailwind, thème sombre
- Temps réel : SSE pour les statuts/logs, WebSocket pour le chat
- Persistance : SQLite (bun:sqlite) — UNIQUEMENT l'historique réseau
- Notifications : ntfy (topic privé) pour le push iPhone

## Règles d'architecture
- Le dashboard est STATELESS vis-à-vis d'OpenClaw : on lit son état
  (logs, sessions, config), on ne duplique jamais ses données
- Bind serveur : IP Tailscale ou 127.0.0.1 uniquement, JAMAIS 0.0.0.0
- Auth : bearer token depuis .env (jamais commité)
- Pas de dépendance lourde sans justification ; préférer la stdlib Bun

## Phases
1. MVP : health panel (gateway/Ollama/WhatsApp), provider actif,
   log tail SSE, moniteur réseau (ping + graphe 7j, SQLite)
2. Chat riche : WS vers le gateway, markdown, tool calls visibles
3. Push : endpoint POST /notify → dashboard + relais ntfy

## Environnement
- macOS (Mac mini M-series), lancement via launchd à terme
- OpenClaw tourne sur la même machine ; ses chemins de config/logs
  sont dans .env (OPENCLAW_HOME, GATEWAY_URL, etc.)
