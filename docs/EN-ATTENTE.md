# En attente — pistes écartées volontairement

Ce que **je ne fais pas maintenant**, et pourquoi. Sortir une piste du `TODO.md`
n'est pas l'abandonner : c'est refuser qu'elle encombre une liste de travail
actionnable alors qu'elle est bloquée, prématurée ou d'un rapport valeur/risque
défavorable.

Relire ce fichier quand une condition de déblocage change (typiquement : le
passage en HTTPS, ou une décision de l'opérateur).

Dernière revue : 2026-07-25.

---

## Bloquées sur une action de l'opérateur

### Certificats HTTPS Tailscale

`tailscale cert` répond « your Tailscale account does not support getting TLS
certs ». Il manque un interrupteur dans la console d'administration Tailscale
(DNS → HTTPS Certificates → Enable). MagicDNS est déjà actif, c'est le seul
prérequis manquant.

**Ce que ça débloquerait** — beaucoup plus que du confort :

- `navigator.clipboard` et `crypto.randomUUID`, aujourd'hui **absents** (pas
  seulement bloqués) faute de contexte sécurisé ; deux contournements
  disparaîtraient.
- Les notifications Web Push (voir ci-dessous), qui exigent un contexte
  sécurisé et un service worker.
- L'installation PWA sur iPhone.

**Reste à faire ensuite** : `tailscale serve --bg --https=443
http://127.0.0.1:3001`, passage de `BIND_HOST` à `127.0.0.1` (déjà validé par
`parseEnv`), et vérification que SSE et WebSocket passent bien le proxy.

### Test d'intégration de la livraison WhatsApp

Exige d'émettre de vrais messages vers le téléphone de l'opérateur. Impossible
à automatiser sans le spammer, et un canal simulé ne prouverait rien : les
trois bugs de synchronisation de juillet venaient tous du comportement **réel**
de la gateway, jamais d'une erreur de logique locale.

### Actions de pilotage (relancer le canal WhatsApp, forcer un re-check)

Les RPC existent (`channels.start`, `channels.stop`, `channels.logout`) mais
`channels.logout` peut délier le compte. Une action destructive sur le canal
qui porte toute la continuité de l'agent demande une décision explicite de
l'opérateur sur le périmètre exact et la confirmation exigée — pas une
initiative.

---

## Écartées après investigation

### Répondre à une demande d'autorisation depuis le dashboard

**Recherché, non trouvé.** Le flux `approval` signale bien qu'un run est
suspendu — c'est déjà exploité par le bandeau d'activité — mais l'énumération
des méthodes RPC de la gateway ne révèle **aucune** méthode de réponse
(`approvals.*` ne couvre que la configuration : `approvals.exec.mode`,
`approvals.exec.enabled`…). `message.action` sert l'envoi vers un canal, pas la
résolution d'une approbation.

Conclusion : les autorisations se répondent sur le canal d'origine. Comme
l'opérateur est de toute façon sur WhatsApp, la boucle est fermée sans nous.
Le dashboard se contente de **signaler** l'attente, ce qui est le vrai apport.

À rouvrir si une version d'OpenClaw expose une méthode de résolution.

### Notifications Web Push natives d'OpenClaw

La gateway expose `push.web.subscribe`, `push.web.unsubscribe`,
`push.web.vapidPublicKey` et `push.web.test` : une infrastructure Web Push
complète, avec VAPID, qui serait supérieure à un relais ntfy.

Bloquée sur le contexte sécurisé (voir HTTPS ci-dessus) : Web Push exige HTTPS
et un service worker. **À privilégier sur ntfy le jour où HTTPS est en place** —
une dépendance externe de moins.

### Reprise des logs par curseur (`Last-Event-ID`)

L'idée était de ne rien perdre entre deux connexions SSE. **L'architecture la
rend sans objet** : `LogTailer` ne tourne QUE tant qu'un client écoute
(`pause()` dès le dernier désabonnement) et repart avec un curseur vide. Quand
plus personne ne regarde, rien n'est collecté — il n'y a donc rien à rejouer,
et un tampon de reprise serait systématiquement vide au moment où il servirait.

Changer cela signifierait faire tourner le tail en permanence et conserver un
historique en mémoire : c'est-à-dire transformer une vue en direct en journal,
ce que le produit refuse. Les logs complets vivent chez OpenClaw.

### Coloration syntaxique des blocs de code

Se recalculerait à chaque delta de streaming, pour un gain que le soin apporté
au cadre (titre, bouton de copie, surface contrastée, monospace réglée) couvre
déjà largement. Coût en poids et en saccades non justifié.

### Sélecteur de sessions

Tant que la session principale n'est pas éprouvée — trois bugs de
synchronisation corrigés en une semaine — multiplier les sessions
multiplierait la surface de bug. À reconsidérer après une période de calme
réel.

### Édition ou renvoi d'un message déjà envoyé

OpenClaw n'a pas de sémantique d'édition. L'implémenter simulerait une capacité
inexistante : l'interface mentirait.

### Suppression et renommage de fichiers dans l'onglet Fichiers

Destructif. La lecture et l'ajout couvrent le besoin exprimé ; la suppression
demande une décision explicite sur la confirmation et l'auditabilité.

---

## Prématurées

### Virtualisation de la liste de messages

Le transcript est plafonné à 500 messages et le rendu ne montre aucun signe de
lenteur. Virtualiser casserait la recherche par `scrollIntoView` et la
restitution de position. À reconsidérer si le plafond monte.

### Recherche dans les payloads d'appels d'outils

`searchMessages` ne regarde que le texte des messages. Étendre aux arguments et
résultats d'outils annoncerait des résultats **invisibles** (ces blocs sont
repliés par défaut) — malhonnête tant que le surlignage ne sait pas déplier le
bloc concerné.

### Multi-utilisateur, RBAC, Prometheus/Grafana, ORM, broker

Interdits par les décisions d'architecture tant qu'un besoin réel ne dépasse
pas SQLite + SSE/WS sur un tailnet mono-propriétaire. Voir `CLAUDE.md`.
