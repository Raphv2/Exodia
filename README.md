# Terrain · carte militante

Web app responsive (PC et mobile, installable sur l'écran d'accueil) pour organiser le terrain :

- **Deux espaces vraiment séparés**, imposés par le serveur :
  - **LFI** (style insoumis, violet et jaune) : panneaux électoraux, collage, tractage, trajet de collage ;
  - **Mouvement** (style journal militant : noir, blanc, rouge sang) : blocus, blocages, police / CRS.
  - Le reste existe des deux côtés (AG, rassemblement, local, dépôt de matériel, flash, warning, danger), mais chaque point appartient à un seul espace. Le matériel et les alertes proposés sont propres à chaque espace, sans référence croisée.
  - Un appareil ne reçoit **jamais** les points, photos ou notifications d'un espace auquel il n'a pas accès. L'écran de connexion est neutre.

- **Carte** : points fixes (panneaux électoraux, blocages, local, matériel, point de collage…) et événements (rassemblement, blocus, tractage, AG, collage, matériel, local, autre), chacun avec une couleur, une icône, une photo et une description facultatives.
- **Événements** : avec un horaire, par exemple « 5 h 30, quai 43 », ou sur toute la journée. Ils disparaissent de la carte tout seuls à la fin. L'auteur·rice ou un admin peut les **terminer** plus tôt : ils restent alors dans l'agenda.
- **Flash** ⚡ : troisième choix à la création (à côté de « Point fixe » et « Événement ») pour une action improvisée. Pas de date à saisir : ça commence maintenant, dans 15 min (par défaut), 30 min ou 1 h, pour 30 min à 3 h. Tout le monde reçoit une notification, et l'épingle porte un petit éclair.
- **Blocus et blocages** : le **blocus** est l'événement (le RDV, avec son horaire). Chaque **blocage** est un point fixe posé sur un bâtiment, car la barricade reste en place même sans personne. N'importe qui indique s'il est **tenu** (du monde sur place), **sans personne** ou **levé**, avec l'heure de la dernière mise à jour. Un blocage peut être rattaché à un blocus, depuis le formulaire ou depuis la fiche du blocus qui liste ses blocages. Quand le blocus se termine, ses blocages encore tenus passent tout seuls à « sans personne ».
- **Warning / Danger / Police** : deux boutons dédiés sur la carte pour signaler un problème en deux gestes. Le bouton Danger permet aussi de signaler **police / CRS** (épingle bleue qui clignote). Chaque situation prédéfinie a sa propre icône (agression, blessé, CRS, BAC, nasse, fourgons…) pour comprendre d'un coup d'œil. L'alerte reste visible 15 min, 30 min, 1 h ou 2 h, puis disparaît toute seule. N'importe qui peut la prolonger (« Toujours là »).
- **Votes en AG** (côté Mouvement, façon Kahoot) : l'organisateur·rice d'une AG (ou un admin) lance un vote, avec une question et des choix (Pour / Contre / Abstention par défaut). L'app affiche un **code à 5 chiffres** en grand. N'importe qui, **même sans l'app**, tape le code via « J'ai un code de vote » sur la page d'accueil et vote, **seulement s'il est à moins de 50 m de l'AG**. Un seul vote par appareil, choix anonyme. Les résultats sont visibles en direct par l'organisation, puis par tout le monde une fois le vote clos. Limites assumées : une position GPS peut être falsifiée, et une navigation privée donne un nouvel « appareil ».
- **Qui vient, qui fournit** : à la création d'un événement, on coche le **matériel nécessaire** (suggestions selon le type, plus ses propres ajouts). Sur la fiche, chacun indique **« Je participe »** et, pour chaque élément, **« Je fournis »**. Les deux sont indépendants : fournir n'oblige pas à venir. Le matériel que personne ne fournit est mis en évidence.
- **Problème sur un blocage** : n'importe qui peut **signaler un problème** (barricade enlevée, des gens dans le bâtiment, manque de monde…) sans créer d'alerte séparée. L'épingle **clignote en rouge** chez tout le monde jusqu'à ce que quelqu'un le marque comme réglé, ou que le délai choisi expire.
- **Agenda** : les événements de la semaine (sans les points fixes), sur la couleur de leur type, avec l'icône, l'horaire et un aperçu de la description. Gère la récurrence (chaque jour, semaine, mois) et signale les problèmes en cours.
- **Trajet de collage** : sélection des panneaux et points de collage, calcul de l'ordre le plus court, puis export vers **Google Maps** (découpé automatiquement en parties de 9 étapes), **GPX** (Organic Maps, OsmAnd, Komoot…), **Waze** (prochain arrêt) ou partage par message.
- **Équipe** : invitations par QR code, rôles, révocation des appareils.
- **Temps réel** : quand quelqu'un ajoute un point ou une alerte, la carte se met à jour partout, avec une notification pour les alertes.

Stack : **TypeScript** partout. Serveur Node + Express + SQLite (module `node:sqlite` intégré, aucune compilation native) ; interface Vite + TypeScript sans framework, avec Leaflet et OpenStreetMap.

## Démarrer en local

Il faut **Node 22.13 ou plus récent**.

```bash
npm install
npm run dev
```

- Interface : http://localhost:5180 (accessible aussi depuis un téléphone sur le même Wi-Fi, via l'adresse « Network » affichée par Vite).
- API : http://localhost:3180

Au premier lancement, la console affiche un **lien d'invitation admin** (valable 24 h, usage unique). Ouvre-le sur l'appareil qui sera admin. Tant qu'aucun admin n'existe, un nouveau lien est créé à chaque redémarrage et l'ancien est annulé.

Appareil propriétaire perdu ? Sur le serveur, `npm run invite-admin -- https://ton-domaine.fr` crée une invitation de secours (1 h, usage unique) qui redonne un accès propriétaire aux deux espaces.

> La géolocalisation et l'appareil photo ne fonctionnent qu'en **HTTPS** (ou sur `localhost`). Pour tester sur un téléphone avant la mise en ligne, utilise un tunnel HTTPS (par ex. `cloudflared tunnel --url http://localhost:5180`).

## Mettre en ligne

**Avec Docker : [DOCKER.md](DOCKER.md)** (`docker compose up -d`, Caddy en option pour le HTTPS).

**Guide pas à pas pour un VPS sans Docker : [DEPLOIEMENT.md](DEPLOIEMENT.md).** Le script `deploy/install.sh` installe tout en une commande : Node, Caddy avec HTTPS, service systemd, sauvegardes quotidiennes et pare-feu.

L'hébergement PHP mutualisé ne fait pas tourner Node. Il faut un serveur Node avec un **disque persistant**, car la base SQLite et les photos sont dans `data/`.

En manuel :

```bash
npm ci
npm run build      # compile l'interface dans dist/web
npm start          # sert l'interface et l'API sur $PORT (3180 par défaut)
npm run backup -- /chemin/sauvegardes 14   # copie cohérente de la base + photos, garde 14 jours
```

Variables d'environnement :

| Variable | Rôle |
|---|---|
| `PORT` | Port d'écoute en production (fourni par l'hébergeur). |
| `PUBLIC_URL` | URL publique, ex. `https://terrain.mondomaine.fr`, utilisée dans les liens d'invitation. |
| `TRUST_PROXY` | `1` derrière un reverse proxy HTTPS (cookies `Secure`, vraie IP pour la limitation). |
| `DATA_DIR` | Dossier des données (`data` par défaut). |
| `HOST` | Adresse d'écoute ; `127.0.0.1` pour n'accepter que le reverse proxy. |

## Sécurité : pourquoi pas l'IP ou l'adresse MAC ?

- L'**adresse MAC** n'est jamais transmise à un site web : un navigateur ne peut pas la lire.
- L'**adresse IP** change sans arrêt sur mobile (4G, Wi-Fi, box) et elle est partagée par tous les gens derrière une même box. Elle bloquerait les vrais membres et laisserait passer les autres.

Le modèle retenu, c'est la **confiance de main en main, avec un appareil = une clé** :

1. **On n'entre que par invitation.** Un admin (ou un relais) génère un QR code ou un lien, avec une durée de validité et un nombre d'usages limités. Par défaut : 15 min, 1 personne.
2. Le jeton d'invitation est placé après le `#` du lien : il n'est jamais envoyé au serveur dans l'adresse, n'apparaît pas dans les journaux et n'est pas transmis aux autres sites. Le serveur ne stocke que son empreinte SHA-256.
3. En acceptant l'invitation, l'appareil reçoit une **clé secrète de 256 bits**, rangée dans un cookie `HttpOnly` (illisible par les scripts), `SameSite=Strict` et `Secure` en HTTPS. Pas de mot de passe à retenir ni à se faire voler.
4. **Traçabilité** : chaque appareil sait qui l'a fait entrer. Un admin peut retirer un appareil, et **toute la chaîne d'invitations qui en découle** en un clic (utile en cas d'infiltration). Le dernier admin ne peut pas être retiré.
5. **Rôles** : *propriétaire* (le tout premier appareil : accès aux deux espaces, seul à nommer des admins et à leur donner un ou deux espaces, ne peut pas être retiré), *admin* (gère les relais et membres de ses espaces, modifie tous les points de ses espaces), *relais* (peut faire entrer une personne à la fois, en face à face, QR valable 1 h au plus, dans son espace), *membre* (ajoute des points et des alertes, modifie les siens). Chaque invitation fixe l'espace : LFI, Mouvement ou les deux.
6. Défenses supplémentaires : protection CSRF (en-tête obligatoire), limitation des tentatives d'invitation, politique de sécurité du contenu (CSP) stricte, photos servies uniquement aux appareils autorisés, photos ré-encodées dans le navigateur avant l'envoi (ce qui **supprime les données EXIF**, dont la position GPS), ménage automatique (alertes expirées, photos orphelines, invitations mortes).

Bon réflexe : montrer le QR code **en direct** plutôt que d'envoyer le lien par message, puisqu'un lien peut être transféré.

## Organisation du code

```
shared/   modèle commun (types de points, couleurs, récurrence)
server/   API Express : accès et invitations, points et photos, temps réel (SSE)
web/src/  interface : carte, formulaires, agenda, trajet, équipe, styles
```

## Limites à connaître

- Les fonds de carte viennent des serveurs d'OpenStreetMap, ce qui convient à un groupe militant. Pour un usage intensif, passe à un fournisseur de tuiles (MapTiler, Stadia…) en modifiant `web/src/map.ts`.
- Le trajet est optimisé à vol d'oiseau (algorithme du plus proche voisin, puis 2-opt). L'itinéraire rue par rue est ensuite calculé par Google Maps ou par l'app de navigation.
- Google Maps limite chaque lien à 9 étapes intermédiaires : au-delà, le trajet est découpé en plusieurs parties.
