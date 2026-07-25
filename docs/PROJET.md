# clawdeck — référence complète du projet

Document de référence unique : ce qu'est le produit, ce qu'il fait, pourquoi
chaque décision structurante a été prise, et les pièges déjà payés.

**À lire avant toute évolution.** Les autres documents restent normatifs sur
leur périmètre — `CLAUDE.md` (architecture), `docs/UI_UX.md` (interface),
`TODO.md` (travail à venir), `docs/EN-ATTENTE.md` (écarté volontairement).
Ce fichier les relie et porte le savoir acquis à la dure.

Dernière mise à jour : 2026-07-25.

---

## 1. Ce qu'est clawdeck — et ce qu'il n'est pas

Console d'exploitation privée pour **un seul opérateur**, qui observe et pilote
une instance **OpenClaw** locale depuis un Mac mini headless, joignable
uniquement via Tailscale.

La particularité qui commande tout le reste : **l'agent supervisé n'existe pas
seulement dans cette fenêtre.** Il tourne en continu, agit sur une vraie
machine, et converse aussi sur WhatsApp. clawdeck est une fenêtre sur quelque
chose qui vit sans lui — pas un client de chat dont l'objet n'existerait que
pendant qu'on le regarde.

**Ce n'est pas** : une landing page, une reproduction du Control UI d'OpenClaw,
un outil d'administration système générique, ni un produit multi-utilisateur.

### Règle d'or

clawdeck est **STATELESS vis-à-vis d'OpenClaw**. Il lit son état (logs,
sessions, config) et ne duplique jamais ses données. La seule chose que
clawdeck persiste est l'historique des pings réseau, dans SQLite. Le
transcript du chat n'est **jamais** stocké : il vient de `chat.history` et du
flux live, et vit en mémoire, plafonné à 500 messages.

---

## 2. Architecture

```
Navigateur (React/Vite)
   │  HTTP + bearer token   │ SSE /api/status, /api/logs   │ WS /api/chat/ws
   ▼                        ▼                              ▼
        Backend Bun + Hono  (sert aussi le front buildé)
   │  RPC WebSocket, auth par identité d'appareil Ed25519
   ▼
        Gateway OpenClaw (protocole v3-v4)
```

- **Backend** : Bun + Hono, TypeScript. Sert l'API et `web/dist`.
- **Front** : React + Vite + Tailwind v4, thème sombre, interface française.
- **Temps réel** : SSE pour statuts et logs, WebSocket pour le chat.
- **Persistance** : SQLite (`bun:sqlite`), pings uniquement, rétention 7 jours.

### Une seule connexion vers la gateway

Le backend maintient **une** connexion WS authentifiée vers OpenClaw
(`src/gateway/client.ts`) et la relaie à tous les navigateurs authentifiés. Un
navigateur ne peut pas poser d'en-tête sur un handshake WebSocket : l'auth du
chat se fait donc par **première frame** (`{type:"auth", token}`), avec un
délai de grâce de 5 s, et non par header — d'où l'exception dans le middleware.

### Fichiers structurants

| Fichier | Rôle |
| --- | --- |
| `src/index.ts` | routes HTTP, SSE, relais WS du chat, service statique |
| `src/gateway/client.ts` | client WS vers OpenClaw : handshake, watchdogs, RPC |
| `src/gateway/protocol.ts` | construction de la charge d'auth signée |
| `src/env.ts` | validation stricte de l'environnement (`parseEnv`) |
| `src/status-collector.ts` | boucle unique de sondes, diffusée à tous les clients |
| `src/workspace.ts` | écriture confinée dans le workspace de l'agent |
| `web/src/hooks/useChat.ts` | traduction du flux gateway en modèle d'affichage |
| `web/src/lib/timeline.ts` | regroupement des messages, séparateurs de jour |
| `web/src/lib/activity.ts` | logique du bandeau d'activité |

---

## 3. Contraintes absolues

Ces règles ne se négocient pas sans décision explicite de l'opérateur.

1. **Bind sur `127.0.0.1` ou une IP Tailscale, JAMAIS `0.0.0.0`.** Validé par
   une liste d'autorisation dans `src/env.ts` (loopback + plages CGNAT
   Tailscale).
2. **Auth par bearer token depuis `.env`**, jamais commité. Comparaison en
   **temps constant** (`safeTokenEqual`, `crypto.timingSafeEqual`).
3. **Aucune donnée d'OpenClaw dupliquée.** Voir la règle d'or.
4. **Pas de dépendance lourde sans justification.** Préférer la stdlib Bun.
5. **Interface française**, responsive dès 320 px, focus visible,
   `prefers-reduced-motion` respecté.
6. **`docs/UI_UX.md` est la référence obligatoire du front.** Une évolution
   étend ce système ; si elle change la direction, elle met le document à jour
   dans le même commit.

---

## 4. Fonctionnalités par onglet

### Vue d'ensemble (santé)

- Statut HTTP et RPC de la gateway, provider et modèle réellement actifs,
  état WhatsApp, Ollama et son modèle de repli.
- Sondes réseau : Cloudflare, passerelle locale, site distant
  (83.204.110.38). Graphe de latence 24 h / 7 j, agrégé côté SQL à ~360
  points quelle que soit la fenêtre.
- **Fraîcheur explicite** : badge d'âge, seuils périmé (15 s) et mort (60 s).
  Une donnée ancienne ne reste jamais verte sans afficher son âge.

### Chat

Voir §5 pour les décisions d'interface. Fonctionnellement :

- Miroir de la session principale, **y compris les messages échangés depuis
  WhatsApp**, dans les deux sens.
- Streaming des réponses, appels d'outils repliables avec arguments et
  résultats bornés.
- Accusés d'envoi (`en cours` → `envoyé` / `échec` + réessai), interruption
  d'un run (`chat.abort`, aussi par Échap).
- **Bandeau d'activité** : ce que fait l'agent maintenant, y compris pour un
  run déclenché hors du dashboard, et l'attente d'autorisation — état
  bloquant qui était auparavant indiscernable d'un run qui travaille.
- **Route de livraison affichée dans le composeur** : « ↗ WhatsApp · +33… »
  ou « Session interne ».
- Regroupement des messages, séparateurs de jour, recherche locale, copie,
  brouillon persisté, compteur de caractères, amorces opérationnelles.

### Logs

Tail SSE via `logs.tail`, filtré et rédigé par OpenClaw, borné en mémoire,
**jamais persisté** par clawdeck.

### Fichiers

- **Lecture** via la gateway (`agents.workspace.list/get`, scope
  `operator.read`) : confinement et rédaction assurés côté OpenClaw.
- **Écriture** en direct sur le disque, confinée par `src/workspace.ts`
  (défense anti-traversée et anti-symlink par `realpath`), car
  `agents.files.set` aurait exigé `operator.admin` pour l'écriture.
- Pas de suppression ni de renommage : destructif, décision non prise.

---

## 5. Décisions d'interface et leur raison

Le détail normatif est dans `docs/UI_UX.md`. Voici le pourquoi.

**Superfamille IBM Plex (Sans + Mono), auto-hébergée, latin, ~89 Ko.**
Choix structurel et non décoratif : l'interface affiche en permanence des
heures, latences, chemins et payloads en monospace au contact du texte
courant. Deux familles assorties partagent hauteur d'x et dessin des chiffres,
si bien qu'une ligne comme `OpenClaw · 16:34 · via WhatsApp` cesse de
ressembler à deux polices qui se télescopent. `tabular-nums` global pour que
les compteurs ne gigotent pas.

**Traitement asymétrique des interlocuteurs.** L'opérateur écrit court : bulle
compacte à droite. L'agent répond avec du code, des tableaux et des appels
d'outils : bloc pleine largeur adossé à un rail vertical qui porte l'état de
la réponse. Une bulle étroite écrasait ces contenus sans rien apporter.

**Le composeur porte son destinataire.** C'est la signature de l'interface, et
elle encode le fait le plus distinctif du produit : ce qu'on tape part aussi
sur un vrai téléphone. Affiché *dans* le cadre de saisie, jamais en légende
flottante — une rupture de continuité doit se voir avant l'envoi, pas après la
perte d'un message.

**Animations strictement fonctionnelles.** Chacune signale un changement
d'état réel : arrivée d'un message, curseur d'écriture pendant le streaming,
bascule de canal. L'historique initial ne s'anime jamais.

**Honnêteté avant confort.** Un run muet depuis 90 s sort du bandeau plutôt
que d'être affiché « en cours ». Le bandeau se tait hors connexion. La
recherche annonce qu'elle ne porte que sur les messages chargés.

---

## 6. Pièges connus — savoir acquis à la dure

> Cette section a plus de valeur que le reste du document. Chaque point a coûté
> un incident réel.

### Scopes gateway : la table de permissions ne dit pas tout

`chat.send` accepte des champs `originatingChannel`/`originatingTo`/
`originatingAccountId`. La table centrale de scopes les classe en
`operator.write` — **c'est faux** : le *handler* pose une garde
supplémentaire et exige `operator.admin`. Une réduction de scope « propre »
faite en lisant la seule table a cassé l'envoi en production le 2026-07-18.

**Leçon** : toujours vérifier les gardes dynamiques dans le handler, pas
seulement la table. Et comprendre POURQUOI le code existant fait quelque chose
avant de le « corriger » comme sur-privilégié.

### `operator.admin` est un choix délibéré

Sans route d'origine explicite sur `chat.send`, chaque message envoyé depuis le
dashboard re-marque la session « webchat » et les réponses **cessent d'arriver
sur le téléphone**. Le scope admin est le prix de la continuité WhatsApp.
Coût accepté sur un tailnet privé mono-utilisateur. Ne pas « optimiser » ce
point sans relire cette section.

### La route de livraison doit être re-résolue paresseusement

Résolue une seule fois à la connexion, elle rate un « ping » WhatsApp arrivé
*après*. `resolveDeliveryRoute()` est donc rappelée avant chaque envoi tant que
la route est inconnue.

### `sessions.changed` : le miroir meurt en silence

L'abonnement `sessions.messages.subscribe` meurt avec la ligne de session
recréée. Les réponses de l'agent continuaient d'arriver (flux de streaming, non
scopé session) mais **les messages entrants de WhatsApp disparaissaient** —
d'où une asymétrie déroutante. L'événement `sessions.changed` invalide la route
et refait `setupSession()`.

### Fenêtre anti-doublon : mesurer depuis la FIN

La déduplication de l'écho de session courait depuis le *début* du streaming.
Toute réponse mettant plus de 30 s à s'écrire était donc dupliquée. Les états
terminaux remettent le timestamp à l'heure de fin.

### Contexte non sécurisé : les API modernes sont ABSENTES

Le dashboard est servi en `http://` sur une IP Tailscale. `navigator.clipboard`
et `crypto.randomUUID` **n'existent pas** — ils ne sont pas seulement bloqués.
D'où `web/src/lib/clipboard.ts` (repli sur `document.execCommand`) et un
générateur d'id local. **Passer en HTTPS via Tailscale Serve supprimerait ces
contournements** ; c'est bloqué sur l'activation des certificats HTTPS dans la
console d'administration Tailscale (`tailscale cert` répond « your Tailscale
account does not support getting TLS certs »).

### `networkidle` n'arrive jamais

Deux flux SSE et un WebSocket restent ouverts en permanence : toute attente de
réseau au repos expire. Les outils de capture utilisent `domcontentloaded`.

### L'adaptateur Bun de Hono recrée le `WSContext`

Le `readyState` d'un `WSContext` est figé à sa création. Pour savoir si un
client est encore vivant lors d'un accusé asynchrone, lire `ws.raw?.readyState`.
Et pour retirer un client du `Set`, retirer **la même instance** que celle
ajoutée, sinon le `Set` fuit un contexte par connexion.

### Événements `agent` : enveloppe et battements de cœur

Forme réelle : `{ runId, stream, ts, sessionKey, spawnedBy?, isHeartbeat?, data }`.
Flux existants : `tool`, `approval`, `lifecycle`, `error`, `thinking`,
`command_output`, `stdout`, `stderr`, `patch`, `plan`… Les événements
`isHeartbeat` prouvent la liaison, **pas** une activité de l'agent.

### Provenance d'un message

OpenClaw pose `sourceChannel` (+ `senderId`/`senderName`/`senderE164`) sur ce
qui **entre** par un canal externe. L'étiquette « via WhatsApp » exige canal
externe **ET** identité d'expéditeur : nos propres envois épinglent
`originatingChannel: whatsapp`, le seul critère du canal les étiquetterait à
tort comme venant du téléphone.

---

## 7. Exploitation

### Démarrage

```bash
bun install && bun install --cwd web
cp .env.example .env      # AUTH_TOKEN, GATEWAY_URL, GATEWAY_AUTH_TOKEN, BIND_HOST
bun run dev               # backend --watch + Vite
```

Le premier démarrage crée une identité d'appareil Ed25519
(`data/gateway-device-identity.json`, non commitée). La supprimer fait de
clawdeck un nouvel appareil aux yeux de la gateway.

### Production

```bash
bun run build             # le daemon sert web/dist
sudo scripts/install-launchd.sh
```

Le front étant servi depuis le disque, **un simple `bun run build` suffit à
déployer un changement purement front** — aucun redémarrage. Un changement
backend exige de relancer le service.

**État au 2026-07-25** : le daemon launchd n'est PAS chargé ; le service tourne
sur un processus lancé à la main, qui ne survivra pas à un redémarrage.
`sudo scripts/install-launchd.sh` reste à exécuter par l'opérateur.

### Vérification

```bash
bun run check             # typecheck + lint + test + build
bun scripts/screenshot.ts # captures réelles en 390/768/1440 px
```

`scripts/screenshot.ts` est le seul moyen de juger le rendu : la machine n'a
pas de session graphique. Il signale aussi les erreurs console et les
débordements horizontaux, invisibles sur une capture.

---

## 8. Ce qui n'est délibérément pas fait

- **Édition ou renvoi d'un message déjà envoyé** : OpenClaw n'a pas de
  sémantique d'édition. L'implémenter simulerait une capacité inexistante.
- **Coloration syntaxique des blocs de code** : se recalculerait à chaque
  delta de streaming ; le cadre soigné et une monospace bien réglée donnent
  l'essentiel de la lisibilité sans ce coût.
- **Sélecteur de sessions** : tant que la session principale n'est pas
  éprouvée, multiplier les sessions multiplierait la surface de bug.
- **Suppression et renommage de fichiers** : destructif, décision non prise.

Les pistes mises de côté avec leur raison sont dans `docs/EN-ATTENTE.md`.
