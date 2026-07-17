# Règles UI/UX de clawdeck

Ce document est la référence pour toute évolution de l'interface. Une nouvelle
fonction doit étendre ce système, pas inventer une nouvelle direction visuelle
ou un nouveau comportement local.

## 1. Intention

clawdeck est une console d'exploitation privée. L'interface doit être :

- calme : peu de couleurs, aucun effet décoratif qui concurrence les données ;
- lisible d'un coup d'œil : état global, anomalies, puis détails ;
- honnête : distinguer inconnu, périmé, dégradé et indisponible ;
- compacte sans être dense : utilisable sur un iPhone comme sur un écran Mac ;
- prévisible : mêmes composants, mêmes mots et mêmes états partout.

Le produit n'est ni une landing page, ni une reproduction du Control UI
OpenClaw, ni un outil d'administration système générique.

## 2. Hiérarchie obligatoire

Chaque vue suit le même ordre :

1. le header global indique l'identité, la navigation et la connexion à
   clawdeck ;
2. le titre de page explique le périmètre en une phrase ;
3. le résumé donne la conclusion opérationnelle ;
4. les cartes montrent les états individuels ;
5. les panneaux donnent l'historique ou les détails.

Une information globale ne doit pas être cachée dans une carte. Une information
de diagnostic ne doit pas prendre la place de la conclusion.

## 3. Fondations visuelles

### Couleurs

Les couleurs partagées sont des variables dans `web/src/index.css` :

- canvas : fond de l'application ;
- panel : conteneur principal ;
- raised : contenu posé dans un panel ;
- primary/secondary/muted : trois niveaux de texte maximum ;
- accent : sélection, focus et action principale ;
- good/warning/critical/unknown : états opérationnels uniquement.

Ne pas ajouter une couleur hexadécimale dans un composant si elle représente un
token réutilisable. Le vert d'accent ne signifie pas à lui seul « sain » : un
statut comporte toujours un symbole ou point et un libellé.

### Typographie

- Sans-serif système pour l'interface et le contenu.
- Monospace pour heures, latences, identifiants, commandes et payloads.
- Casse phrase pour les titres et boutons. Les capitales sont réservées aux
  micro-labels de catégorie, avec un espacement de lettres modéré.
- Une page possède un seul `h1`; les panels ont un `h2`; les cartes un `h3`.

### Espacement et formes

- Grille de base : 4 px. Espacements usuels : 8, 12, 16, 24, 32 et 40 px.
- Rayon standard : 12 px pour carte/panel, 8 px pour contrôle interne, pilule
  uniquement pour un statut ou un choix compact.
- Bordure subtile avant l'ombre. Les ombres sont réservées aux overlays,
  tooltips et à la porte d'authentification.
- Pas de gradients décoratifs multiples. Un halo de fond très discret est
  admis pour donner de la profondeur au canvas.

## 4. Sémantique des états

Les quatre états sont fixes :

| État | Sens | Présentation |
| --- | --- | --- |
| Opérationnel | Sonde récente réussie | vert + point + libellé |
| Dégradé | Service joignable, capacité partielle | ambre + `!` ou point + libellé |
| Indisponible | Sonde récente en échec | rouge + `!` ou point + libellé |
| En attente | Pas encore de mesure fiable | gris/ambre neutre + `…` + libellé |

Une donnée trop ancienne devient « périmée » même si sa dernière valeur était
bonne. Ne jamais conserver visuellement un état vert sans afficher l'âge de la
mesure.

Les états réseau clawdeck↔navigateur et clawdeck↔OpenClaw sont différents. Ils
doivent être nommés explicitement, jamais fusionnés dans un seul voyant ambigu.

## 5. Composants et interactions

### Navigation

- Deux niveaux maximum dans le MVP.
- Onglet actif avec `aria-current="page"` et contraste de surface, pas seulement
  une couleur de texte.
- Sur mobile, la navigation reste visible et les cibles tactiles font au moins
  40 px de haut (44 px dès que l'espace le permet).

### Cartes de statut

- Ordre interne fixe : identité/service, statut, titre/détail, mesure.
- Le statut principal ne peut pas être remplacé par la latence.
- Une erreur utile est courte dans la carte ; le détail complet appartient à un
  panneau ou tooltip accessible.

### Actions

- Une vue ne contient qu'une action principale visuellement forte.
- Un bouton désactivé doit avoir une raison visible dans le contexte.
- Les actions distantes ne sont déclarées réussies qu'après accusé du backend.
- Une action destructive ou ayant un impact externe demande une confirmation
  avec conséquence explicite.
- Pas d'action au survol uniquement : tout doit fonctionner au clavier/tactile.

### Chat

- Entrée envoie, Maj+Entrée crée une ligne.
- L'envoi est indisponible si la gateway est hors ligne et le placeholder dit
  pourquoi.
- Ne pas forcer le scroll si l'utilisateur relit un message plus haut.
- Messages, outils et erreurs ont des identités distinctes. Les payloads d'outil
  sont repliables et bornés pour ne pas écraser la conversation.
- Un message optimiste doit ensuite être réconcilié avec un accusé ou marqué en
  échec ; il ne doit jamais disparaître silencieusement.

### Graphiques

- Toujours nommer les séries, l'unité et la période.
- Une couleur par série, stable dans tout le produit.
- Les trous et échecs restent visibles ; ne pas relier artificiellement deux
  périodes séparées par une absence de données.
- Fournir un titre/une description accessible et une conclusion textuelle si
  le graphique porte une information critique.

## 6. États d'une vue

Chaque fonctionnalité définit avant livraison :

- chargement initial : squelette ou message d'attente stable ;
- vide : expliquer ce qui apparaîtra et à quelle condition ;
- erreur : cause compréhensible et prochaine action possible ;
- déconnecté : dernière donnée marquée périmée ou contenu rendu indisponible ;
- reconnexion : automatique seulement si elle est bornée et non bruyante ;
- succès : accusé discret, sans toast si le résultat est déjà visible.

Une zone blanche, un spinner sans texte ou une boucle infinie « connexion… » ne
sont pas des états acceptables.

## 7. Responsive et accessibilité

- Concevoir d'abord à 320–390 px, puis 768 px et 1280 px.
- Aucun scroll horizontal de page. Les données longues scrollent dans leur
  composant (`pre`, table ou payload).
- Les contrôles critiques gardent une cible tactile suffisante et ne reposent
  pas sur le hover.
- Focus clavier visible avec la couleur d'accent.
- Respecter `prefers-reduced-motion`.
- Utiliser éléments HTML sémantiques, labels de formulaire et `aria-live`
  uniquement pour les changements utiles.
- Contraste WCAG AA visé pour le texte ; le texte muted ne porte jamais seul une
  information critique.

## 8. Langue et rédaction

- Interface en français. Les noms techniques officiels restent inchangés :
  OpenClaw, Ollama, gateway, SSE, WebSocket.
- Phrases courtes, concrètes, sans jargon décoratif.
- Bouton = verbe ou résultat clair : « Envoyer », « Ouvrir le dashboard ».
- Statut = constat : « Opérationnel », « Gateway indisponible ».
- Éviter « OK », « Erreur » ou « Échec » sans préciser quel système est concerné.
- Tutoiement uniquement dans l'aide directe ; descriptions système neutres.

## 9. Checklist avant merge

- [ ] La fonction respecte la hiérarchie globale → résumé → détail.
- [ ] Elle réutilise les tokens et composants existants.
- [ ] Loading, vide, erreur, périmé et déconnecté sont traités.
- [ ] Les statuts ne reposent pas uniquement sur la couleur.
- [ ] Le clavier, le tactile et le focus visible fonctionnent.
- [ ] La vue tient à 320 px sans scroll horizontal.
- [ ] Les textes sont en français et suivent le vocabulaire existant.
- [ ] Les actions distantes ont un état pending/succès/erreur honnête.
- [ ] Build, lint et vérification visuelle desktop/mobile passent.

