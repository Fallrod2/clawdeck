# clawdeck — frontend

Front React + Vite + Tailwind (thème sombre, interface française) du dashboard
clawdeck. Les règles visuelles et d'interaction sont dans `../docs/UI_UX.md`
(référence obligatoire) ; le contexte produit dans `../CLAUDE.md`.

## Commandes

Depuis ce dossier (ou via les scripts racine qui les enchaînent) :

```bash
bun install        # dépendances (lockfile bun.lock)
bun run dev        # serveur Vite sur localhost:5173, proxy /api → backend :3001
bun run typecheck  # tsc -b
bun run lint       # oxlint
bun run build      # build de production dans dist/ (servi par le backend Hono)
```

En dev, lancer plutôt `bun run dev` à la RACINE du repo : il démarre backend
et front ensemble (voir `../dev.ts`). Le proxy Vite relaie aussi le WebSocket
du chat (`ws: true`).

## Structure

```
src/components/   panneaux et cartes (statuts, chat, logs, graphe latence)
src/hooks/        flux temps réel (SSE statuts/logs, WS chat, historique pings)
src/lib/          types partagés, frames WS, token navigateur
src/index.css     tokens de thème et styles globaux (source de vérité visuelle)
```

Principes : aucun secret dans le bundle, token saisi par l'utilisateur et
stocké côté navigateur, états chargement/vide/erreur/périmé toujours rendus,
responsive dès 320 px.
