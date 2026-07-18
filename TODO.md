# Roadmap clawdeck

Ce fichier est la liste de travail durable du projet. Il décrit l'ordre de
priorité, pas seulement une liste d'idées. Une tâche cochée doit être livrée,
testée et documentée.

## Cap produit

clawdeck doit répondre rapidement à quatre questions :

1. OpenClaw, son provider actif, Ollama et WhatsApp fonctionnent-ils vraiment ?
2. Le Mac mini et son accès réseau sont-ils stables dans le temps ?
3. Que fait l'agent maintenant, et que disent ses logs récents ?
4. Peut-on converser avec l'agent et recevoir une alerte sans dupliquer son état ?

Contraintes permanentes :

- OpenClaw reste la source de vérité pour les sessions, le chat, la config et
  les logs. SQLite ne contient que l'historique réseau.
- Le serveur n'écoute que sur loopback ou une adresse Tailscale, jamais sur
  toutes les interfaces.
- Aucun secret dans Git, dans le front buildé, dans les logs ou dans une réponse
  d'erreur.
- Pas d'endpoint d'exécution shell arbitraire et pas de dépendance lourde sans
  bénéfice mesurable.

## État constaté — 2026-07-17 (revue complète : `docs/REVUE-2026-07-17.md`)

- [x] Backend Bun/Hono, front React/Vite/Tailwind et service launchd.
- [x] Auth bearer pour l'API et authentification de la WebSocket navigateur.
- [x] Cartes gateway/Ollama/réseau, SSE de statut et historique de ping SQLite.
- [x] Chat de la session principale via la gateway, streaming Markdown et
  événements d'outils.
- [x] Build, typecheck et lint passent localement.
- [x] Socle UI/UX cohérent et règles durables dans `docs/UI_UX.md`.
- [x] Phase 1 complète : provider actif, état WhatsApp et tail des logs exposés
  sans nouvelle persistance.
- [x] Phase 2 robuste (2026-07-18) : accusés d'envoi avec retry, interruption
  de run, fermeture 1008 traitée en auth, réconciliation d'écho ciblée, types
  aux frontières, état conservé entre onglets, mémoire bornée. Reste ouvert :
  réconciliation de l'historique après reconnexion quand l'UI a déjà des
  messages, et test d'intégration WhatsApp reproductible.
- [ ] Phase 3 : aucune notification dashboard/ntfy n'est implémentée.
- [ ] Qualité : 45 tests unitaires (env, validation, network, collecteurs,
  logs, log-tailer, watchdog gateway, openclaw-status) ; il manque encore db,
  les routes HTTP/WS de bout en bout, et toute CI.
- [x] Le chat cassé en mode dev (proxy Vite sans WebSocket) : corrigé le
  2026-07-17 (`ws: true`).

## P0 — Fiabiliser les fondations

Ces tâches passent avant l'ajout de nouvelles fonctions : les métriques et le
chat ne sont pas fiables tant qu'elles ne sont pas terminées.

- [x] Découpler la collecte de statut des connexions SSE.
  - Lancer une seule boucle de sondes au démarrage du backend, même quand aucun
    navigateur n'est ouvert.
  - Conserver uniquement le dernier snapshot en mémoire et le diffuser à tous
    les clients SSE.
  - Empêcher le chevauchement de deux cycles et éviter qu'un nouvel onglet
    multiplie les pings, requêtes HTTP et écritures SQLite.
  - Envoyer immédiatement le dernier snapshot lors d'une nouvelle connexion.
- [x] Borner le ping ICMP macOS avec `-t` (durée globale sur la version actuelle),
  `-W` (attente de réponse) et un watchdog Bun qui tue/récolte le sous-processus
  en cas de dépassement ; tester succès, sortie non nulle et processus muet.
- [x] Durcir et centraliser la validation de configuration au démarrage
  (fait le 2026-07-17 : `parseEnv` pur et testé dans `src/env.ts`).
  - [x] `PORT` entier 1-65535, URL http(s) obligatoires, chemins non vides,
    erreurs françaises lisibles sans jamais citer un secret.
  - [x] `AUTH_TOKEN` : refuse `change-me` et moins de 16 caractères.
  - [x] `BIND_HOST` : allowlist stricte loopback (127.0.0.0/8, localhost, ::1)
    + Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) ; `0.0.0.0`, `::` et les
    IP LAN sont refusés (`isAllowedBindHost`, testé aux bords de plage).
  - [x] Utiliser `/health` pour la sonde HTTP OpenClaw (fait, `checks.ts:21`).
  - [x] Comparaison de tokens constant-time centralisée (`safeTokenEqual` dans
    `src/validate.ts`), utilisée par l'API et le WS chat — à réutiliser pour
    le futur `/notify`.
- [x] Corriger le proxy Vite (`ws: true`) — fait le 2026-07-17, chat dev
  fonctionnel.
- [x] Log-tailer silencieux quand la gateway est déconnectée (fait le
  2026-07-17 : `LogTailSource.isConnected`, aucun événement d'erreur, reprise
  automatique au tick suivant la reconnexion ; testé).
- [x] `getHistory().then(...)` protégé par `.catch` + garde sur l'état vivant
  du socket (`ws.raw`) — fait le 2026-07-17. Au passage, correction d'une
  fuite préexistante : l'adaptateur Bun de Hono recrée un `WSContext` par
  événement, donc `chatClients.delete(ws)` en `onClose` ne retirait jamais
  l'instance ajoutée à l'auth (un contexte fuité par connexion, broadcast
  vers des sockets morts).
- [x] Corriger la détection du modèle Ollama : un autre tag du même modèle ne
  doit pas faire croire que le tag de fallback configuré est disponible.
- [x] Valider les entrées HTTP/WS (fait le 2026-07-17) : `hours` fini, borné
  et clampé via `parseHours` (`?hours=abc` → 400 `{"error":"invalid hours"}`,
  vérifié en réel), texte de chat borné à `MAX_CHAT_TEXT_LENGTH` (8 000
  caractères) avec erreur explicite au client. Le typage strict des formes de
  messages reste couvert par l'item P2 « types des frames ».
- [x] Stabiliser le client gateway selon le protocole OpenClaw installé
  (terminé le 2026-07-17, spec vérifiée dans le paquet installé —
  `/opt/homebrew/lib/node_modules/openclaw/docs/gateway/protocol.md` — et
  connexion validée en live contre la gateway réelle v2026.7.1).
  - [x] Watchdog de handshake (10 s, timer lié à son socket, testé via
    `socketFactory` injectable) et jitter 0,5-1,0 sur le backoff.
  - [x] Protocole négocié vérifié : `hello-ok.payload.protocol` doit tomber
    dans [3, 4], sinon fermeture explicite (jamais « connecté » sur un
    dialecte inconnu).
  - [x] `hello-ok.features.methods` : découverte conservatrice stockée, gating
    de toutes nos méthodes (`request` rejette tôt, `setupSession` gate
    explicitement, `LogTailer.supportsLogs` saute sans erreur répétée) ;
    fail-open si la liste est absente.
  - [x] `hello-ok.policy.tickIntervalMs` : watchdog de vivacité — fermeture
    code 4000 après 2 × l'intervalle sans frame entrante (comme le client de
    référence), réarmé à chaque frame, fallback 30 s.
  - [x] Échecs de `connect` : `retryAfterMs` honoré tel quel (sans gonfler le
    backoff, ex. `UNAVAILABLE` « startup-sidecars ») ;
    `AUTH_TOKEN_MISMATCH`/`AUTH_SCOPE_MISMATCH` → message opérateur clair et
    reconnexion automatique suspendue jusqu'à `start()`, conformément à la
    spec.
  - [x] Timeout par RPC.
  - [x] Suivi `seq` par connexion : trou → un événement `resync` (unique par
    trou) qui resonde immédiatement l'état OpenClaw ; recul = nouveau flux,
    adopté sans bruit.
  - [x] Remise à zéro de la route de livraison et de tout l'état négocié à la
    déconnexion ; désabonnement `sessions.messages.unsubscribe` best-effort à
    l'arrêt.
  - [x] Audit des scopes : `operator.admin` retiré, tout fonctionne en
    read/write. Correction du 2026-07-18 après constat en prod : la table de
    scopes ne dit pas tout — le handler `chat.send` réserve les champs
    `originating*` explicites à admin (« originating route fields require
    admin scope »). Réglé proprement : `deliver: true` seul (write), la
    gateway résout elle-même la route de la session (même chaîne de repli
    que notre ancien code client, désormais supprimé). Leçon durable : tout
    audit de scope doit vérifier la table ET les gardes dynamiques du
    handler. Conséquence assumée du moindre privilège : un slash-command
    d'administration tapé dans le chat est refusé. Le RPC `status` réservant
    provider/modèle aux admins, la lecture passe par `sessions.list` +
    `agents.list` (read) — vérifié en live.
- [x] Ajouter un arrêt propre : stopper la gateway et les timers, terminer les
  flux SSE/WS et fermer SQLite sur `SIGTERM`/`SIGINT`.

## P1 — Terminer réellement le MVP d'observabilité

- [x] Compléter le test HTTP `/health` de la gateway par son RPC `health` et
  présenter séparément : processus joignable, disponibilité agent, uptime et
  durée/âge de la dernière sonde.
- [x] Afficher le provider et le modèle actifs à partir du snapshot/RPC de la
  gateway, sans recopier la configuration dans clawdeck.
- [x] Ajouter une carte WhatsApp fondée sur la santé live de la gateway : compte
  configuré, connecté, dernière activité/reconnexion et erreur utile, sans
  exposer de numéro ou de credential.
- [x] Relayer `logs.tail` de la gateway vers un endpoint SSE dédié.
  - Filtrer côté UI par niveau/sous-système et borner le nombre de lignes.
  - Conserver les logs uniquement en mémoire dans le navigateur ; aucun stockage
    SQLite et aucun tail direct d'un chemin fourni par la requête.
  - Respecter la redaction OpenClaw, ajouter une limite de taille et gérer un
    client lent sans accumuler une file illimitée.
- [ ] Améliorer le moniteur réseau (largement fait le 2026-07-18).
  - [x] Stats de période par série sous le graphe : p50/p95 (nearest-rank),
    % de buckets en échec (« <1 % » plutôt qu'un 0 mensonger), nombre de
    trous de collecte.
  - [x] Tracé cassé sur les trous (> 1,5 × bucket) — un point isolé reste
    visible ; `<desc>` SVG dynamique.
  - [x] Race de `usePingHistory` fermée (AbortController, réponse obsolète
    jamais appliquée) + arrêt sur 401 + `lastUpdatedAt` exposé.
  - [x] Tooltip : tolérance proportionnelle au bucket (0,75 ×), navigation
    clavier ←/→/Échap, échec écrit en toutes lettres.
  - [x] Indicateur « données périmées » du graphe (> 2 × le cycle de 30 s).
  - Distinguer une panne Internet d'une panne de passerelle locale.
  - Invalider le cache de `detectDefaultGateway` (TTL ou échecs répétés) : une
    bascule de route par défaut fige les pings « orange » sur l'ancienne IP.
- [x] Retourner une erreur d'auth claire dans `TokenGate` et arrêter la boucle de
  reconnexion sur 401 jusqu'à la saisie d'un nouveau token.
- [ ] Ajouter `/api/healthz` minimal pour clawdeck (sans secret ni détails).
- [x] État « données périmées » dans l'interface (fait le 2026-07-18) : badge
  d'âge unique dans l'en-tête (`FreshnessBadge` + `useNow`, en pause onglet
  caché), tons des six cartes atténués + aria « donnée périmée » au-delà de
  15 s, bannière globale qui ne reste jamais verte sur un SSE figé.
- [x] Backoff exponentiel plafonné (1 s → 30 s, reset à la première frame) sur
  les trois reconnexions front + relance immédiate sur `online` /
  `visibilitychange`, avec garde anti-double-connexion (fait le 2026-07-18).
- [x] 401 propre partout : `useLogStream` expose un état `auth` calme
  (« Authentification requise »), `usePingHistory` coupe son cycle ; plus de
  « HTTP 401 » brut ni d'erreur avalée (fait le 2026-07-18).

## P2 — Achever le chat riche

- [x] Types aux frontières (fait le 2026-07-18) : union discriminée
  `ServerFrame` + `parseServerFrame` côté front (frames malformées/inconnues
  ignorées), narrowing `unknown` côté backend — plus aucun `any` aux
  frontières du relais chat. Les payloads gateway internes restent `unknown`
  réduits par narrowing, par choix (forme non garantie stable).
- [ ] Fiabiliser l'identité et l'ordre des messages.
  - [x] Ne plus dédupliquer deux vrais messages par simple égalité rôle+texte
    (fait le 2026-07-17) : l'écho optimiste est réconcilié avec son message
    `local-*` récent (l'id devient le `stableId` serveur), et un assistant
    sans `runId` n'est comparé qu'aux réponses en streaming ou finalisées
    depuis moins de 30 s. Deux « ok » espacés apparaissent désormais tous
    les deux.
  - Réconcilier l'écho optimiste, l'accusé `chat.send`, le streaming, le miroir
    `session.message` et l'historique après reconnexion.
  - Recharger/réconcilier l'historique même si l'UI contient déjà des messages.
- [x] `clientMessageId` + accusés `send-ok`/`send-error` du backend, états
  visibles « envoi en cours »/« échec » + bouton « Réessayer » (nouveau
  clientMessageId, l'ancien ne cible plus rien) ; l'écho de session vaut
  preuve de livraison et rattrape un échec apparent (fait le 2026-07-18,
  protocole vérifié en réel ; compatible vieux front/vieux backend).
- [x] Désactiver l'envoi quand la gateway est déconnectée, pas seulement quand
  la WebSocket vers clawdeck est fermée.
- [x] Afficher les arguments, mises à jour et résultats d'outils dans des blocs
  repliables, avec état d'erreur et JSON formaté de façon bornée.
- [x] Fermeture WS `1008` traitée en état d'auth : `wsState "unauthorized"`,
  aucune retentative, purge du token unifiée avec la garde SSE existante
  (fait le 2026-07-18).
- [x] Historique chat borné (cap glissant 500 épargnant les messages
  pending/failed, purge de `runIdToMessageId`) — fait le 2026-07-18.
- [x] État du chat conservé au changement d'onglet : `useChat` remonté au
  niveau App, panneaux chat/logs montés en permanence (masqués par `hidden` +
  `inert` + `aria-hidden`) — fait le 2026-07-18.
- [x] Interruption via `chat.abort` (`abortRun` côté client gateway, frames
  `abort`/`abort-ok`/`abort-error`, bouton « Interrompre » pendant la réponse,
  états en attente/interrompu/échoué affichés) — fait le 2026-07-18.
- [ ] Vérifier la livraison WhatsApp par un test d'intégration reproductible :
  message envoyé depuis le dashboard, réponse visible dans le dashboard et dans
  le canal d'origine, sans doublon.
- [ ] Après stabilisation de la session principale, décider si un sélecteur de
  sessions est utile. Ne pas ajouter de copie locale de leur historique.

## Fait hors roadmap — onglet Fichiers (2026-07-18)

- [x] Consultation du workspace de l'agent : navigation par dossiers, fil
  d'Ariane, préviz texte/images, via `agents.workspace.list/get`
  (operator.read, confinement et redaction côté gateway), `.git` filtré.
- [x] Ajout de fichiers (téléversement ≤ 10 Mo + création de fichier texte)
  par écriture directe confinée (`src/workspace.ts`, 9 tests paranoïaques :
  traversées, symlink d'évasion, `.git`, écrasement contrôlé) —
  `agents.files.set` aurait exigé `operator.admin` qu'on ne demande pas.
- [x] Routes `GET /api/workspace`, `GET /api/workspace/file`,
  `POST /api/workspace/files` (400/404/409/413/502/503 typées), vérifiées en
  live contre la gateway réelle. Pas de suppression/renommage (destructif —
  décision explicite à prendre plus tard si le besoin émerge).

## P3 — Notifications dashboard + ntfy

- [ ] Spécifier `POST /api/notify` : payload versionné (`title`, `message`,
  `severity`, `tags`, identifiant optionnel), limites de taille et réponses
  documentées.
- [ ] Protéger l'endpoint avec le bearer token, comparaison sûre, rate limit
  simple en mémoire et clé d'idempotence courte durée.
- [ ] Diffuser immédiatement la notification aux navigateurs connectés via SSE
  ou WS, avec toast accessible. Ne pas créer d'historique applicatif.
- [ ] Relayer vers un topic ntfy privé configuré uniquement dans `.env`, avec
  timeout, authentification, validation stricte de l'URL et erreurs sans secret.
- [ ] Définir le comportement en panne : la notification locale peut réussir
  même si ntfy échoue, mais la réponse doit signaler séparément les deux états.
- [ ] Ajouter un test local avec faux serveur ntfy et documenter un exemple
  `curl` sans véritable token/topic.

## P4 — Tests, sécurité et exploitation

- [x] Ajouter des scripts racine `check`, `typecheck`, `lint` et `test` qui
  couvrent backend et frontend avec une seule commande.
- [ ] Écrire des tests unitaires Bun pour : validation env, payload signé,
  identité device, timeouts/reconnexion RPC, parsing des événements, agrégation
  SQLite et validation des routes API. (16 tests existent déjà — network,
  collecteurs, logs, openclaw-status — mais aucun sur ces zones-là, qui sont
  précisément celles où la revue a trouvé les bugs.)
- [ ] Écrire des tests d'intégration avec fausses gateway/Ollama/ntfy et une base
  temporaire ; ne jamais dépendre de l'instance OpenClaw réelle dans la CI.
- [ ] Ajouter un smoke test frontend pour auth, rendu des statuts, reconnexion et
  envoi de chat. Garder l'outil léger tant qu'un navigateur complet n'est pas
  justifié.
- [x] CI GitHub Actions (fait le 2026-07-18) : installs `--frozen-lockfile`
  racine + web, typecheck, lint, tests, build (`.github/workflows/ci.yml`).
- [ ] Ajouter des en-têtes de sécurité (`CSP`, `frame-ancestors`, `nosniff`,
  `Referrer-Policy`, `Cache-Control` adapté pour l'API) et vérifier que le
  Markdown ne peut pas injecter HTML/URL dangereuse.
- [ ] Ajouter des logs backend structurés et sobres : démarrage, arrêt, état des
  connexions, erreurs de sonde et reconnexions, jamais les tokens ni le contenu
  du chat.
- [x] Déploiement launchd reproductible (fait le 2026-07-18) :
  `scripts/install-launchd.sh` idempotent — vérifie `.env` (en exécutant la
  validation d'env réelle du backend), le build et le plist AVANT tout
  changement système, crée le dossier de logs, bootout/bootstrap ; rollback
  documenté dans le README ; `ThrottleInterval` 15 s dans le plist contre les
  boucles de crash au boot.
- [ ] Ajouter une procédure de sauvegarde/restauration limitée à la base de
  pings et à l'identité gateway, avec permissions `0600` documentées.
- [ ] Remplacer le README Vite générique de `web/` par les commandes et choix
  propres à clawdeck, puis synchroniser README/CLAUDE.md avec l'état réel.

## Corrections rapides (constats mineurs de la revue 2026-07-17)

Chacune tient en quelques lignes ; à grouper dans un même lot de nettoyage.

- [x] `web` : `tailwindcss`/`@tailwindcss/vite` déplacés en `devDependencies` ;
  `remark-gfm` ajouté à `react-markdown` (tableaux, listes de tâches, barré —
  toujours sans `rehype-raw`, HTML échappé) — fait le 2026-07-18.
- [x] `App.tsx` : variante `xs:` supprimée, `aria-label` des deux `nav`
  dédoublonnés, `refresh` inutilisé retiré (fait le 2026-07-18).
- [x] `ChatPanel.tsx` : `prefers-reduced-motion` respecté pour le `scrollTo`
  (fait le 2026-07-18).
- [x] `LogsPanel.tsx` : `aria-hidden` sur le point décoratif, « tail tronqué »
  remis à zéro sur `reset` (fait le 2026-07-18).
- [x] `index.css` : `Inter` retiré, sans-serif système seule (UI_UX.md §3) —
  fait le 2026-07-18.
- [x] `openclaw-status.ts` : `lastError` devenu informatif, ne dégrade plus un
  canal WhatsApp rétabli (fait le 2026-07-17, testé).
- [x] `status-collector.ts` : un `refresh()` reçu pendant un cycle est mis en
  file et déclenche une collecte immédiate en fin de cycle (fait le
  2026-07-17, testé).
- [x] README de `web/` réécrit pour clawdeck (commandes et structure réelles)
  — fait le 2026-07-17.

## P5 — Améliorations après les trois phases

À faire seulement si les phases précédentes sont fiables et si l'usage réel le
justifie.

- [ ] Bandeau d'anomalies récentes sous le résumé global : dernier échec de
  sonde ou déconnexion avec horodatage, visible même après retour au vert.
- [ ] Reprise des logs par curseur (`Last-Event-ID` SSE) pour ne rien perdre
  entre deux connexions.
- [ ] Actions de pilotage bornées et confirmées (relancer le canal WhatsApp,
  forcer un re-check) via des opérations OpenClaw explicites — dans le respect
  de la règle « pas de commande système générique » ci-dessous.
- [ ] Résumé d'usage et de quota via les RPC OpenClaw (`usage.status`/
  `usage.cost`), sans nouvelle persistance.
- [ ] Vue diagnostic en lecture seule : version OpenClaw, stabilité récente,
  sessions actives et état mémoire, avec données sensibles masquées.
- [ ] Installation derrière Tailscale Serve en HTTPS pour éviter le contexte
  HTTP sur IP et améliorer la protection du token navigateur.
- [ ] PWA/mobile : manifeste, icônes et mise en page iPhone, sans introduire de
  cache offline des chats ou de la configuration.

## Décisions à ne pas prendre implicitement

- Pas de multi-utilisateur/RBAC tant que le dashboard reste mono-propriétaire et
  privé sur le tailnet.
- Pas de Prometheus/Grafana, broker de messages ou ORM avant qu'un besoin réel
  dépasse SQLite + SSE/WS.
- Pas de bouton générique pour lancer des commandes système. Toute action de
  pilotage future doit appeler une opération OpenClaw explicite, bornée,
  confirmée et auditée.
- Pas de persistance des notifications, logs, sessions, messages, modèles ou
  config : si une vue doit survivre à un rechargement, elle doit être relue
  depuis OpenClaw.

## Prochain jalon conseillé

P0 est terminé au complet (2026-07-17) : validation env/entrées, client
gateway conforme à la spec du paquet installé (protocole vérifié, features,
tick, retryAfterMs, seq, scopes minimaux), collecte découplée, arrêt propre —
le tout testé (57 tests) et validé en live contre la gateway réelle.

Le prochain lot logique est le duo P1 « honnêteté visuelle » + P2 « chat
fiable » : badge d'âge/péremption et backoff des reconnexions front d'un côté,
`clientMessageId` + accusés d'envoi + fermeture 1008 côté chat de l'autre.
Redémarrer le service launchd sur ce commit avant d'attaquer la suite, pour
faire tourner la prod sur le client durci (vérifier d'abord la force
d'`AUTH_TOKEN` dans `.env` : la validation refuse désormais un token faible).
