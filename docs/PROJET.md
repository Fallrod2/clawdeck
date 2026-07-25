# clawdeck — référence complète du projet

Document de référence unique : ce qu'est le produit, ce qu'il fait, pourquoi
chaque décision structurante a été prise, et les pièges déjà payés.

**À lire avant toute évolution.** Les autres documents restent normatifs sur
leur périmètre — `CLAUDE.md` (architecture), `docs/UI_UX.md` (interface),
`TODO.md` (travail à venir), `docs/EN-ATTENTE.md` (écarté volontairement).
Ce fichier les relie et porte le savoir acquis à la dure.

Dernière mise à jour : 2026-07-25 (soirée — les trois phases sont livrées).

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
| `web/src/lib/historyMerge.ts` | fusion de l'historique après reconnexion |
| `web/src/lib/chatSearch.ts` | recherche locale, insensible aux accents |
| `src/security.ts` | en-têtes, garde bearer, sonde de vie — routes publiques en un seul endroit |
| `src/notify.ts` | notifications : validation, diffusion, débit, idempotence, relais ntfy |
| `src/network-diagnosis.ts` | conclusion réseau (local vs amont), pure et testée |
| `src/log.ts` | journal structuré, masquage mécanique des secrets |

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
- **Modèle ayant produit une réponse**, avec le repli local signalé en ambre.
  ⚠️ **Ce badge n'apparaît PAS dans notre déploiement**, et c'est correct :
  voir « le modèle par message est inatteignable ici » au §6.
- **Photos et vocaux reçus de WhatsApp**, lus par `/api/media` avec la même
  garde `realpath` que l'écriture. La CSP doit déclarer `media-src 'self'
  blob:` explicitement : sans elle, la directive retombe sur `default-src` et
  tout blob est refusé (constaté à l'exécution, la prédiction inverse était
  fausse).

### Notifications (phase 3)

`POST /api/notify` accepte un payload versionné, borné, protégé par le bearer
token, avec limitation de débit (20/min, compteur global — un seul opérateur)
et clé d'idempotence à 60 s. Diffusion immédiate en SSE sur
`/api/notifications` et relais optionnel vers ntfy.

Trois décisions structurantes :

- **Aucun historique**, ni serveur ni navigateur. Un client qui arrive ne
  rattrape rien, et un test verrouille ce comportement. Le dashboard n'est pas
  une boîte de réception ; prétendre le contraire obligerait à stocker ce que
  l'architecture refuse de stocker.
- **`207` quand la diffusion locale réussit mais que ntfy échoue.** Un `200`
  masquerait la perte, un `5xx` nierait la diffusion réussie.
- **Une configuration ntfy à moitié remplie fait échouer le démarrage.** Elle
  produirait sinon un relais qui échoue à chaque notification sans que
  personne ne sache pourquoi.

Côté interface, une erreur ne disparaît jamais seule (un avertissement raté
n'a pas rempli son office) ; les informations s'effacent, sinon la pile
deviendrait l'historique qu'on refuse. `role="alert"` est réservé aux erreurs
— il interrompt la lecture d'écran, en abuser le rend inaudible.

### Journal d'anomalies

Détecté côté **backend**, dans le seul point de passage de tous les cycles de
sonde : une détection front n'aurait vu que les pannes survenues pendant qu'un
onglet était ouvert — précisément celles dont on n'a pas besoin d'un journal.
En mémoire, borné à 12 entrées et 24 h ; **ce n'est pas de la persistance**.

Un signal par **sous-système** et non par case rouge : quand la gateway tombe,
sa sonde HTTP, son WebSocket et sa santé RPC s'éteignent ensemble — une entrée,
pas trois. Anti-rebond de 5 min : une anomalie qui revient rouvre son entrée en
incrémentant ses occurrences, plutôt que de produire dix lignes qui perdent le
début de l'épisode.

Le journal **dit ce qu'il ne sait pas** : il repart vide à chaque redémarrage
du backend, l'annonce, et son état vide n'a ni vert ni ✓ — seulement la fenêtre
réellement observée.

### Consommation et quotas

`usage.status` et `usage.cost` (`operator.read` — gardes dynamiques des
handlers vérifiées, pas seulement la table de scopes). Lecture étranglée à
60 s : la boucle de statut frapperait sinon les endpoints fournisseurs près de
6 000 fois par jour.

Deux pièges d'affichage, évités :

- la fenêtre montrée est **la plus consommée**, celle qui décide du blocage —
  ni la moyenne, ni la première déclarée par le fournisseur ;
- `totalCost` **n'est pas une facture** mais une valorisation calculée depuis
  la table de tarifs d'OpenClaw ; avec des entrées non tarifées
  (`missingCostEntries`), ce n'est même plus un total mais un plancher. Sur les
  données réelles (102 entrées sans tarif, total à 0), l'interface annonce
  « valorisation impossible » plutôt qu'un zéro trompeur.

`sessions.usage` est écartée deux fois : non annoncée dans le hello-ok
(`advertise: false`), et sa réponse porte des numéros WhatsApp.

### Logs

Tail SSE via `logs.tail`, filtré et rédigé par OpenClaw, borné en mémoire,
**jamais persisté** par clawdeck. La reprise par curseur a été étudiée et
écartée : le tailer ne tourne que tant qu'un client écoute, il n'y a donc rien
à rejouer (voir `docs/EN-ATTENTE.md`).

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

### `Bun.serve` tue les flux SSE au bout de 10 secondes

Le défaut `idleTimeout` de Bun ferme toute requête restée **silencieuse** dix
secondes. Or le silence est l'état NORMAL d'un flux SSE : un tail de logs peut
ne rien avoir à dire pendant des minutes.

Mesuré le 2026-07-25 : `/api/notifications` tombait à 8,5 s, `/api/logs` à
12 s. Conséquence grave et invisible — les notifications émises pendant la
reconnexion étaient **perdues**, puisque rien n'est conservé par conception.
Seul `/api/status` survivait, par chance : il émet toutes les 5 s.

Deux protections, pas une : `idleTimeout: 240` sur `Bun.serve`, et un
battement de maintien sur chaque flux qui peut rester muet. Le seul indice
était une ligne discrète dans stdout — `[Bun.serve]: request timed out after
10 seconds`. **Vérifier la durée de vie réelle d'un flux long après toute
montée de version de Bun.**

### Reconnexion immédiate : ne jamais doubler un flux

Les quatre flux du front (statut, logs, notifications, chat) se relancent au
retour du réseau ou de la visibilité. Le piège : abandonner la requête en
cours puis rappeler `connect()` fait sortir l'ancienne en erreur, laquelle
programme *sa* reconnexion — un flux de plus à chaque bascule d'onglet.
Mesuré sur `useNotifications` avant correction : **4 bascules → 4 flux SSE
parallèles**, chaque notification livrée quatre fois.

Le motif retenu partout : un drapeau `waitingRetry`, vrai seulement pendant
l'attente d'un délai de backoff. La relance immédiate n'agit que dans cet
état, et **laisse tranquille une connexion en cours** — l'interrompre pour la
relancer aussitôt ne gagne rien.

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

### `Buffer.from(x, "base64")` ne lève jamais

Il ignore silencieusement tout caractère hors alphabet et rend des octets
faux. Un `try/catch` autour du décodage est une branche morte : le
téléversement écrivait un fichier **corrompu** en répondant 200. La forme doit
être validée AVANT de décoder (`isValidBase64`, `src/validate.ts`).

### Un module qui valide à l'import rend toute la suite fragile

`src/env.ts` évaluait la configuration au chargement : importer le module
échouait sans `.env`. Conséquence non évidente — `bun test src/env.test.ts`
était impossible à lancer seul, alors que ce fichier ne teste que des
fonctions pures, et la suite complète ne passait que parce qu'un AUTRE fichier
amorçait `process.env` en premier. La CI dépendait donc silencieusement d'un
ordre d'exécution. La configuration est désormais résolue au premier accès
(`getEnv()`).

### Le cache de la passerelle par défaut doit expirer de deux façons

Un TTL seul rate la bascule bruyante (Wi-Fi → 4G, adresse injoignable
immédiatement) ; un compteur d'échecs seul rate la bascule silencieuse
(l'ancienne adresse reste pingable mais n'est plus la route par défaut). Les
deux sont nécessaires. Et un ping réussi ne doit **jamais** prolonger le
TTL — c'est précisément le cas que le TTL existe pour rattraper.

### Le modèle par message est inatteignable ici

Chaque message d'historique porte `provider`, `model`, `api` et `usage`. On
pourrait croire l'attribution par réponse gratuite. Mesuré sur le transcript
réel, elle ne l'est pas :

- les messages qui portent le vrai modèle (`openai/gpt-5.6-luna`) ne
  contiennent **que des appels d'outils**, donc aucun texte, donc ne sont
  jamais affichés ;
- le texte que lit l'opérateur est toujours un `openclaw/delivery-mirror`,
  recopie de ce qui a été livré sur le canal — sans modèle ;
- reporter le modèle du tour sur son miroir a été tenté puis abandonné :
  **l'ordre réel place le tour outillé AVANT le message utilisateur** auquel il
  répondrait, l'association ne serait qu'une supposition.

Le code d'extraction est conservé (il est juste, et servirait à un déploiement
sans miroir) mais le badge ne s'affiche nulle part. Ne pas le croire cassé.
La question opérationnelle — « suis-je sur le repli local ? » — est déjà
tranchée globalement et sûrement par la carte « Provider actif ».

Les compteurs `usage` des messages valent tous zéro dans ce transcript : les
afficher serait un mensonge, pas une mesure.

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

La machine n'a **pas de session graphique** : sans ces outils, aucune
évolution d'interface ne peut être jugée autrement qu'en la supposant. Tous
signalent les erreurs console et les débordements horizontaux, invisibles sur
une capture.

```bash
bun run check              # typecheck + lint + 274 tests + build
bun run shots              # l'application réelle, en 390 / 768 / 1440 px
bun scripts/demo-shots.ts  # le banc d'états (web/demo.html)
bun scripts/smoke.ts       # bout en bout sur une instance jetable
bun scripts/backup.ts      # sauvegarde vérifiée
```

**Le banc d'états** (`web/demo.html` + `web/src/demo.tsx`) rend, à partir de
données fixes, tout ce qu'on ne peut pas provoquer sans solliciter l'agent
réel — bloc de code, appel d'outil en erreur, raisonnement, streaming, échec
d'envoi, livraison sortante. Il ne fuite jamais en production : Vite ne
construit qu'`index.html`.

**Le test de fumée** démarre une instance jetable (port libre, base et
identité temporaires, gateway volontairement injoignable) — il exerce donc au
passage le chemin « dépendance indisponible », et ne touche jamais
l'instance de production ni l'OpenClaw réel.

Ces outils ne sont pas du confort : ils ont révélé, dès leur première
exécution, une navigation mobile qui se chevauchait à 390 px, un composeur
repoussé sous la ligne de flottaison, un groupe de 119 px pour le mot « hey »,
et une cause d'échec affichée deux fois.

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
