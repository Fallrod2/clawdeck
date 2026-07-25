# TODO — clawdeck

Liste **actionnable** uniquement. Ce qui est bloqué sur l'opérateur, écarté
après investigation ou prématuré vit dans `docs/EN-ATTENTE.md` — l'y déplacer
n'est pas un abandon, c'est refuser d'encombrer un plan de travail.

Contexte durable du projet : `docs/PROJET.md`. Règles d'interface :
`docs/UI_UX.md`. Architecture : `CLAUDE.md`.

Dernière revue complète : 2026-07-25.

---

## État

- Phases 1 (supervision) et 2 (chat riche) **livrées et éprouvées en réel**.
- Phase 3 (notifications) : non commencée, seul bloc de la feuille de route
  initiale qui reste entier.
- Qualité : **192 tests**, CI GitHub Actions verte, en-têtes de sécurité et
  journaux structurés en place, vérification visuelle possible en headless
  (`bun scripts/screenshot.ts`).
- **Le daemon launchd n'est pas chargé** : le service tourne sur un processus
  lancé à la main, qui ne survivra pas à un redémarrage machine.
  `sudo scripts/install-launchd.sh` — action opérateur, voir README.

---

## Défauts connus à corriger

- [ ] **Cache de `detectDefaultGateway` jamais invalidé.** Une bascule de
  route par défaut (changement de réseau, bascule 4G) fige indéfiniment les
  pings « passerelle locale » sur l'ancienne IP : la carte affiche alors un
  état faux avec l'aplomb d'une mesure fraîche. Ajouter un TTL et une
  invalidation après échecs répétés.
- [ ] **Une panne Internet et une panne de passerelle locale sont
  indiscernables** dans l'interface. Ce sont deux diagnostics opposés (FAI vs
  réseau local) et c'est précisément ce qu'on vient chercher sur ce dashboard.
- [ ] **L'historique du chat n'est pas réconcilié après reconnexion** quand
  l'UI contient déjà des messages : la frame `history` est ignorée dans ce cas
  (`useChat`), donc un message arrivé pendant la coupure reste absent jusqu'au
  rechargement complet.

## Phase 3 — Notifications

- [ ] `POST /api/notify` : payload versionné (`title`, `message`, `severity`,
  `tags`), bornes de taille, bearer token en comparaison sûre, limitation de
  débit en mémoire et clé d'idempotence courte durée.
- [ ] Diffusion immédiate aux navigateurs connectés (SSE ou WS) avec une
  présentation accessible. **Aucun historique applicatif** — cohérent avec la
  règle « rien de ce qui vient d'OpenClaw n'est persisté ».
- [ ] Relais vers un topic ntfy privé, configuré uniquement dans `.env` :
  timeout, validation stricte de l'URL, erreurs sans secret, et état
  « non configuré » explicite plutôt qu'un échec silencieux.
- [ ] Comportement en panne : la notification locale peut réussir alors que
  ntfy échoue ; la réponse doit distinguer les deux états.
- [ ] Test avec un faux serveur ntfy et exemple `curl` documenté sans secret.

> Note : OpenClaw expose une infrastructure Web Push native (VAPID) qui serait
> supérieure à ntfy, mais elle exige HTTPS. Voir `docs/EN-ATTENTE.md`.

## Observabilité

- [ ] Bandeau d'anomalies récentes sous le résumé global : dernier échec de
  sonde ou déconnexion avec horodatage, **visible même après retour au vert**.
  Aujourd'hui une panne transitoire ne laisse aucune trace consultable.
- [ ] Résumé d'usage et de quota via les RPC `usage.status` / `usage.cost`,
  sans nouvelle persistance. À conditionner à `supportsMethod` : ces méthodes
  ne sont pas annoncées par toutes les versions de gateway.
- [ ] Reprise des logs par curseur (`Last-Event-ID`) pour ne rien perdre entre
  deux connexions SSE.

## Tests et exploitation

- [ ] Smoke test frontend automatisé (Playwright est désormais installé) :
  porte d'authentification, navigation des onglets, rendu des statuts. À faire
  tourner contre une instance jetable, jamais contre l'OpenClaw réel.
- [ ] Tests d'intégration avec fausses gateway et Ollama. Les routes HTTP et
  la base sont couvertes ; il manque le comportement des collecteurs face à
  des dépendances qui répondent mal.
- [ ] Procédure de sauvegarde/restauration limitée à la base de pings et à
  l'identité gateway, permissions `0600` documentées. La perte de l'identité
  fait de clawdeck un nouvel appareil aux yeux de la gateway.
- [ ] Synchroniser `README.md` avec l'état réel : polices auto-hébergées,
  outil de capture, en-têtes de sécurité, renvoi vers `docs/PROJET.md`.

## Interface

- [ ] Manifeste et icônes pour l'écran d'accueil iPhone. L'installation PWA
  complète exige HTTPS, mais l'icône et la couleur de thème fonctionnent déjà
  en http.
- [ ] Vue diagnostic en lecture seule : version OpenClaw, stabilité récente,
  sessions actives, état mémoire — données sensibles masquées.

---

## Décisions à ne pas prendre implicitement

- Pas de multi-utilisateur ni de RBAC tant que le dashboard reste
  mono-propriétaire et privé sur le tailnet.
- Pas de Prometheus/Grafana, de broker de messages ni d'ORM avant qu'un besoin
  réel dépasse SQLite + SSE/WS.
- Pas de bouton générique pour lancer des commandes système. Toute action de
  pilotage doit appeler une opération OpenClaw explicite, bornée, confirmée.
- Rien de ce qui vient d'OpenClaw n'est persisté — notifications, logs,
  sessions, messages, modèles, configuration. Une vue qui doit survivre à un
  rechargement se relit depuis OpenClaw.
- `operator.admin` est un choix délibéré, pas un défaut : la continuité
  WhatsApp en dépend. Lire `docs/PROJET.md` §6 avant d'y toucher.
