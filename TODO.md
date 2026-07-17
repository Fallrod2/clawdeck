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

## État constaté — 2026-07-10

- [x] Backend Bun/Hono, front React/Vite/Tailwind et service launchd.
- [x] Auth bearer pour l'API et authentification de la WebSocket navigateur.
- [x] Cartes gateway/Ollama/réseau, SSE de statut et historique de ping SQLite.
- [x] Chat de la session principale via la gateway, streaming Markdown et
  événements d'outils.
- [x] Build, typecheck et lint passent localement.
- [x] Socle UI/UX cohérent et règles durables dans `docs/UI_UX.md`.
- [x] Phase 1 complète : provider actif, état WhatsApp et tail des logs exposés
  sans nouvelle persistance.
- [ ] Phase 2 robuste : le chat fonctionne, mais son protocole, sa reconnexion,
  ses accusés d'envoi et sa déduplication restent fragiles.
- [ ] Phase 3 : aucune notification dashboard/ntfy n'est implémentée.
- [ ] Qualité : aucun test automatisé ni workflow CI n'existe.

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
- [ ] Durcir et centraliser la validation de configuration au démarrage.
  - Valider `PORT`, les URL, les délais et les chemins avec des erreurs lisibles.
  - Refuser `AUTH_TOKEN=change-me`, les tokens trop courts et les valeurs vides.
  - Autoriser `BIND_HOST` uniquement pour loopback ou les plages Tailscale
    attendues, au lieu de refuser uniquement `0.0.0.0`.
  - Utiliser `/health` pour la sonde HTTP OpenClaw et aligner le commentaire de
    `checkGateway` sur le comportement réel.
- [x] Corriger la détection du modèle Ollama : un autre tag du même modèle ne
  doit pas faire croire que le tag de fallback configuré est disponible.
- [ ] Valider toutes les entrées HTTP/WS : `hours` fini et borné, texte de chat
  avec taille maximale, formes de messages explicites et erreurs stables.
- [ ] Stabiliser le client gateway selon le protocole OpenClaw installé.
  - Négocier la plage de protocoles supportée (actuellement v3-v4) au lieu de
    forcer v4, puis vérifier le protocole réellement négocié.
  - Exploiter `hello-ok.features` avant d'appeler une méthode optionnelle et
    respecter les limites annoncées dans `hello-ok.policy`.
  - Ajouter un timeout à chaque RPC et traiter `connect` refusé, `UNAVAILABLE`,
    `retryAfterMs`, erreur socket et fermeture avec backoff + jitter.
  - Remettre à zéro la route de livraison à chaque déconnexion/changement de
    session et se désabonner proprement à l'arrêt.
  - Suivre `seq`; en cas de trou, recharger `health`, les sessions et
    l'historique au lieu de supposer que les événements sont complets.
  - Auditer les scopes, documenter pourquoi `operator.admin` est nécessaire et
    le supprimer si la livraison WhatsApp fonctionne avec moins de privilèges.
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
- [ ] Améliorer le moniteur réseau.
  - Montrer disponibilité, pertes et périodes sans données en plus de la latence.
  - Rendre la tolérance du tooltip dépendante de la taille réelle des buckets.
  - Distinguer une panne Internet d'une panne de passerelle locale.
  - Exposer l'âge du dernier échantillon pour ne jamais afficher une ancienne
    valeur comme si elle était fraîche.
- [x] Retourner une erreur d'auth claire dans `TokenGate` et arrêter la boucle de
  reconnexion sur 401 jusqu'à la saisie d'un nouveau token.
- [ ] Ajouter `/api/healthz` minimal pour clawdeck (sans secret ni détails) et un
  état « données périmées » dans l'interface.

## P2 — Achever le chat riche

- [ ] Définir des types minimaux pour les frames gateway utilisées et supprimer
  les `any` aux frontières du backend et du hook React.
- [ ] Fiabiliser l'identité et l'ordre des messages.
  - Utiliser les identifiants stables de la gateway ; ne plus dédupliquer deux
    vrais messages uniquement parce que leur rôle et leur texte sont identiques.
  - Réconcilier l'écho optimiste, l'accusé `chat.send`, le streaming, le miroir
    `session.message` et l'historique après reconnexion.
  - Recharger/réconcilier l'historique même si l'UI contient déjà des messages.
- [ ] Ajouter un `clientMessageId` et une réponse succès/erreur du backend ;
  marquer visiblement un message non envoyé et permettre de le retenter.
- [x] Désactiver l'envoi quand la gateway est déconnectée, pas seulement quand
  la WebSocket vers clawdeck est fermée.
- [x] Afficher les arguments, mises à jour et résultats d'outils dans des blocs
  repliables, avec état d'erreur et JSON formaté de façon bornée.
- [ ] Ajouter l'interruption d'un run via `chat.abort` et afficher clairement les
  états en attente, interrompu et échoué.
- [ ] Vérifier la livraison WhatsApp par un test d'intégration reproductible :
  message envoyé depuis le dashboard, réponse visible dans le dashboard et dans
  le canal d'origine, sans doublon.
- [ ] Après stabilisation de la session principale, décider si un sélecteur de
  sessions est utile. Ne pas ajouter de copie locale de leur historique.

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
  SQLite et validation des routes API.
- [ ] Écrire des tests d'intégration avec fausses gateway/Ollama/ntfy et une base
  temporaire ; ne jamais dépendre de l'instance OpenClaw réelle dans la CI.
- [ ] Ajouter un smoke test frontend pour auth, rendu des statuts, reconnexion et
  envoi de chat. Garder l'outil léger tant qu'un navigateur complet n'est pas
  justifié.
- [ ] Ajouter une CI qui installe avec lockfiles figés, exécute les checks et
  construit `web/dist`.
- [ ] Ajouter des en-têtes de sécurité (`CSP`, `frame-ancestors`, `nosniff`,
  `Referrer-Policy`, `Cache-Control` adapté pour l'API) et vérifier que le
  Markdown ne peut pas injecter HTML/URL dangereuse.
- [ ] Ajouter des logs backend structurés et sobres : démarrage, arrêt, état des
  connexions, erreurs de sonde et reconnexions, jamais les tokens ni le contenu
  du chat.
- [ ] Rendre le déploiement launchd reproductible : créer le dossier de logs,
  vérifier `.env` et le build avant bootstrap, valider le plist et documenter
  mise à jour/rollback. Garder les chemins propres à la machine hors d'un
  éventuel template générique.
- [ ] Ajouter une procédure de sauvegarde/restauration limitée à la base de
  pings et à l'identité gateway, avec permissions `0600` documentées.
- [ ] Remplacer le README Vite générique de `web/` par les commandes et choix
  propres à clawdeck, puis synchroniser README/CLAUDE.md avec l'état réel.

## P5 — Améliorations après les trois phases

À faire seulement si les phases précédentes sont fiables et si l'usage réel le
justifie.

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

Le prochain lot doit couvrir tout P0, les tests unitaires associés et la boucle
de collecte centrale. Il est terminé quand un daemon sans navigateur ouvert
continue d'échantillonner le réseau, qu'ouvrir plusieurs onglets ne multiplie
pas les sondes, qu'une gateway muette ne bloque aucune boucle et que chaque RPC
échoue ou se reconnecte dans un délai borné.
