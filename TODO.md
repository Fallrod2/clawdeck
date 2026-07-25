# TODO — clawdeck

Liste **actionnable** uniquement. Ce qui est bloqué sur l'opérateur, écarté
après investigation ou prématuré vit dans `docs/EN-ATTENTE.md` — l'y déplacer
n'est pas un abandon, c'est refuser d'encombrer un plan de travail.

Contexte durable du projet : `docs/PROJET.md`. Règles d'interface :
`docs/UI_UX.md`. Architecture : `CLAUDE.md`.

Dernière revue complète : 2026-07-25.

---

## État

Les **trois phases** de la feuille de route initiale sont livrées :
supervision, chat riche, notifications.

- Qualité : **274 tests**, CI verte, en-têtes de sécurité vérifiés sans
  violation dans Chromium et WebKit, journaux structurés.
- Vérification visuelle en headless — indispensable, la machine n'a pas de
  session graphique : `bun run shots` (application réelle),
  `bun scripts/demo-shots.ts` (banc d'états), `bun scripts/smoke.ts`
  (bout en bout sur instance jetable).
- Sauvegarde : `bun scripts/backup.ts`.
- Accessibilité mesurée : `bun scripts/a11y.ts`. Contraste WCAG AA atteint
  partout ; restent 2 cibles tactiles mineures assumées (onglet Fichiers).

---

## À faire par l'opérateur

- [ ] **Compléter `.env.example`** avec le bloc de configuration ntfy
  ci-dessous. Ce fichier est bloqué par une règle `deny` des réglages Claude
  Code (`Read(./.env.*)`) ; la garde n'a pas été contournée.

  ```
  # Relais push ntfy (optionnel : les trois absentes = « non configuré »)
  NTFY_URL=https://ntfy.sh/
  NTFY_TOPIC=clawdeck-prive
  NTFY_TOKEN=
  ```

  Une configuration **à moitié** remplie fait délibérément échouer le
  démarrage, pour ne pas obtenir un relais qui échoue en silence à chaque
  notification. Tant que rien n'est renseigné, `/api/notify` répond
  `not-configured` — la diffusion vers le dashboard fonctionne quand même.

- [ ] **Charger le daemon launchd** : `sudo scripts/install-launchd.sh`. Le
  service tourne sur un processus lancé à la main, qui ne survivra pas à un
  redémarrage machine.

- [ ] **Activer les certificats HTTPS Tailscale** (console d'administration,
  DNS → HTTPS Certificates). Débloque à lui seul le presse-papiers natif,
  `crypto.randomUUID`, le Web Push natif d'OpenClaw et l'installation PWA —
  voir `docs/EN-ATTENTE.md`.

> Note : OpenClaw expose une infrastructure Web Push native (VAPID) qui serait
> supérieure à ntfy, mais elle exige HTTPS. Voir `docs/EN-ATTENTE.md`.

## Tests et exploitation

- [ ] Tests d'intégration avec fausses gateway et Ollama. Les routes HTTP et
  la base sont couvertes ; il manque le comportement des collecteurs face à
  des dépendances qui répondent mal.
- [ ] Faire tourner `scripts/smoke.ts` en CI. Il fonctionne en local ; en CI
  il faut installer Chromium (~95 Mo par exécution), à arbitrer.

## Interface

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
