# Guide du code de Terrain

Ce guide explique **comment l'application est construite** et **comment lire son code**.
Il complète les commentaires écrits directement dans chaque fichier : le guide donne la vue d'ensemble,
les commentaires expliquent ligne par ligne.

> Ordre de lecture conseillé : ce guide en entier → `shared/model.ts` → `server/db.ts` → `server/auth.ts`
> → `server/index.ts` → `web/src/ui.ts` → `web/src/store.ts` → `web/src/main.ts`, puis les fonctionnalités
> qui t'intéressent. L'autocritique est dans [AUTOCRITIQUE.md](AUTOCRITIQUE.md).

---

## 1. L'application en une phrase

Une **carte partagée** pour un groupe militant, avec deux espaces étanches : **Campagne** (collage, tractage, panneaux) et **Mouvement** (blocus, blocages, alertes police, AG avec votes, archive, chat chiffré).
On entre **sur invitation**, en scannant un QR code. Il n'y a ni mot de passe ni e-mail : c'est l'**appareil** qui est le compte.

## 2. Les trois dossiers

```
terrain/
├── shared/      code commun au serveur ET au navigateur (types, règles)
├── server/      le serveur Node.js : API HTTP + base SQLite + temps réel
├── web/         l'interface qui tourne dans le navigateur
│   ├── index.html
│   ├── public/  icônes, manifeste PWA (copiés tels quels)
│   └── src/     le code TypeScript et le CSS
├── deploy/      fichiers d'installation sur un serveur Linux (systemd, Caddy)
├── Dockerfile, docker-compose.yml   installation avec Docker
└── docs/        ce guide
```

Pourquoi un dossier `shared/` ? Le serveur et le client doivent être d'accord sur la forme d'un « point », sur la liste des types, sur les règles comme « un blocus n'existe que côté Mouvement ».
En écrivant ces règles une seule fois, on évite qu'elles divergent.

## 3. Les technologies, et pourquoi elles

| Outil | Rôle | Pourquoi ce choix |
|---|---|---|
| **TypeScript** | JavaScript avec des types | Le compilateur attrape les fautes (champ mal nommé, `null` oublié) avant l'exécution. |
| **Node.js 22** | Fait tourner le serveur | Contient `node:sqlite` : une base de données sans rien installer. |
| **node:sqlite** (`DatabaseSync`) | Base de données dans un seul fichier | Pas de serveur de base à gérer. Synchrone : simple à lire, et suffisant pour un groupe. |
| **Express 4** | Framework HTTP | Le plus connu, très documenté. |
| **zod** | Validation des données reçues | Tout ce qui arrive du navigateur est vérifié (types, longueurs, valeurs permises) avant d'être utilisé. |
| **tsx** | Lance du TypeScript directement | Pas d'étape de compilation pour le serveur. |
| **Vite** | Outil de build du client | Serveur de dev rapide, et paquet optimisé pour la production. |
| **TS « vanilla »** (sans React/Vue) | Interface | Moins de dépendances et de concepts. La fonction `h()` de `ui.ts` joue le rôle de JSX. |
| **Leaflet** | Carte interactive | Léger, robuste, beaucoup de plugins. |
| **MapLibre + OpenFreeMap** | Fond de carte vectoriel | Gratuit, sans clé d'API, recolorable par espace. |
| **SSE** (Server-Sent Events) | Temps réel | Plus simple que les WebSockets : le serveur pousse, le client écoute. |
| **WebCrypto** | Chiffrement du chat | Intégré au navigateur, les clés peuvent être rendues non exportables. |

## 4. Le trajet d'une action, de bout en bout

Exemple : quelqu'un crée un blocus.

1. **Navigateur, `forms.ts`** : le formulaire remplit un brouillon (`Draft`). Au clic sur « Créer », il appelle `api.createPoint(...)`.
2. **`api.ts`** : la fonction `req()` envoie `POST /api/points` avec le JSON, le cookie de l'appareil et l'en-tête `X-Terrain` (protection CSRF).
3. **Serveur, `index.ts`** : la requête traverse les middlewares dans l'ordre : en-têtes de sécurité → lecture du JSON → `csrf` → `requireDevice`, qui lit le cookie, retrouve l'appareil et le met dans `req.device`.
4. **`routes-points.ts`** :
   - zod valide le corps ;
   - `normalize()` applique les règles métier (dates, mode, couleur auto du blocus, espace autorisé pour ce type) ;
   - un `INSERT` écrit en base.
5. **`events.ts`** : `broadcast('points', {...}, 'mvt')` envoie un message SSE à tous les appareils connectés **qui ont accès à Mouvement**.
6. **Chez les autres, `main.ts`** : l'écouteur SSE reçoit « points » et appelle `store.refresh()`, qui recharge la liste.
7. **`store.ts`** émet l'événement `'points'` ; **`map.ts`** et **`agenda.ts`**, abonnés, se redessinent.
8. **`shouldNotify()`** décide s'il faut afficher une notification (distance à pied, réglage de l'utilisateur, règle « concerné par ce blocus »).

Retenir ce schéma suffit à comprendre 80 % du code : **formulaire → api → route → base → broadcast → store → rendu**.

## 5. Les concepts métier

### Appareils, rôles et espaces
- Un **appareil** (table `devices`) a un rôle : `admin`, `relais` ou `membre`. Il a aussi une liste d'**espaces** (`'lfi'`, `'mvt'` ou les deux) et éventuellement le drapeau **owner** (propriétaire).
- Le code `lfi` est historique : l'interface affiche « Campagne » (`SPACE_LABEL` dans `shared/model.ts`).
- **Hiérarchie** (`canManage` dans `auth.ts`) :
  - le **propriétaire** gère tout le monde ;
  - un **admin** gère les relais et membres dont les espaces sont couverts par les siens ;
  - un **relais** peut seulement inviter des membres, en main propre : 15 min, une personne ;
  - seul le propriétaire crée des admins.
- **Étanchéité** : chaque point a une colonne `space`. `pointFor()` renvoie **404** (et pas 403) pour un point d'un autre espace, pour ne même pas révéler qu'il existe. `broadcast()` filtre aussi par espace.

### Points
- **Mode** : `fixed` (point fixe : panneau, blocage, dépôt…), `event` (avec date de début et de fin, éventuellement répété) ou flash (événement improvisé qui commence dans 15 min).
- **Types** : catalogue `TYPES` dans `shared/model.ts`. Chaque type a un libellé, une couleur, une icône, et les espaces où il existe.
- **Alertes** (warning, danger, police) : des événements courts qui expirent.
- **« Toujours là ! »** : prolonge une alerte ou confirme un problème, au plus une fois par 15 min (`CONFIRM_LOCK_MIN`). Le bouton reste cliquable : un message doux explique pourquoi rien n'a été ajouté.

### Blocus et blocages
- Un **blocus** est l'événement : le rendez-vous.
- Un **blocage** est un point fixe (un bâtiment bloqué) avec un état : *tenu*, *sans personne* ou *levé*. Il peut être rattaché à un blocus (`parent_id`) ; il prend alors sa couleur.
- Quand le blocus se termine, `releaseBlocages()` (lancée chaque minute) fait passer ses blocages *tenus* à *sans personne*.
- Les **problèmes** ne se signalent que sur les blocages. La notification ne va qu'aux personnes concernées par le blocus.

### Participation
- **« Je participe »** et **« Je fournis »** (matériel) sont indépendants (table `pledges`).
- Pour un blocus, on indique son heure d'arrivée (`arriveAt`).

### Votes d'AG (Mouvement)
- On lance un vote sur une AG et on obtient un **code à 5 chiffres** façon Kahoot.
- Le **rayon** (25 à 500 m, ou « Peu importe ») oblige à être sur place, ce qui est vérifié par le GPS avec une marge.
- **Un bulletin par votant**, garanti par la clé primaire `(vote_id, voter_key)`. `voter_key` vaut `d:<id appareil>` pour un membre, ou l'empreinte d'un cookie anonyme pour une personne sans compte.
- Sur une AG **publique** avec « Peu importe », le vote est ouvert à tous **sans code**, depuis la page d'accueil. Il est marqué **indicatif**, parce qu'un navigateur privé permet de revoter.
- Le statut HTTP **428** signifie « il me faut ta position » : le client demande alors le GPS et réessaie.

### Archive (Mouvement)
- Des documents datés (photo, PDF, copie de mail, note), privés ou publics.
- Le serveur reconnaît le vrai type d'un fichier à ses premiers octets (« magic bytes ») et ne se fie pas au nom.
- Un **registre** automatique ajoute les événements passés et les votes clos.

### Chat chiffré de bout en bout (Mouvement)
Le serveur **transporte** des messages qu'il ne peut pas lire. En résumé :
1. Chaque appareil crée une **paire de clés ECDH**. La clé privée est **non exportable** et reste dans IndexedDB ; seule la clé publique part au serveur.
2. Le groupe partage une **clé AES** par « **époque** ». Pour la distribuer, l'appareil qui ouvre l'époque la chiffre **séparément pour chaque membre** : ECDH entre sa clé et celle du membre, puis HKDF, puis AES-GCM. On appelle cela une « enveloppe ».
3. Chaque message est chiffré en AES-GCM, avec un IV aléatoire et des « données associées » (époque, expéditeur) qui empêchent de recoller un message ailleurs.
4. À **chaque changement de membres**, on ouvre une nouvelle époque : un appareil retiré ne peut pas lire la suite. Si un client envoie avec une époque périmée, le serveur répond **409** et le client se resynchronise.
5. Les **codes de sécurité** permettent de vérifier, de vive voix, qu'on parle bien au bon appareil.

Les limites de ce modèle sont détaillées dans l'autocritique.

## 6. Les fichiers un par un

### shared/
- **model.ts**
  - Le dictionnaire commun : types (`Point`, `Device`, `Vote`, `ArchiveItem`, chat…).
  - Le catalogue `TYPES` et les listes prédéfinies (alertes, matériel).
  - Les petites règles pures : `typeInSpace`, `iconOf`, `colorOf`, `nextConfirmAt`.
- **time.ts**
  - `occurrences()` déplie un événement répété sur une période.
  - `isActive()` dit si un point est encore actif ; `liveProblems()` donne les problèmes en cours.

### server/
- **index.ts** : point d'entrée.
  - En-têtes de sécurité (CSP…).
  - Ordre de montage des routes : publiques d'abord, puis protégées par `requireDevice`.
  - Gestionnaire d'erreurs, service du client compilé en production, ménage périodique.
- **db.ts**
  - Ouvre la base SQLite (mode WAL, clés étrangères) et crée les tables.
  - Applique des **migrations relançables** : on ajoute une colonne seulement si `PRAGMA table_info` dit qu'elle manque.
- **auth.ts**
  - Identification par cookie : la base ne stocke que le SHA-256 du jeton, donc une fuite de la base ne donne pas les jetons.
  - Middlewares `requireDevice`, `requireRole`, `csrf`, `rateLimit`.
  - Outils pour les espaces et les droits.
- **events.ts** : temps réel SSE.
  - `stream` garde la connexion ouverte.
  - `broadcast` filtre par espace.
  - `disconnect` coupe un appareil révoqué.
  - Un ping part toutes les 25 s pour que les proxys ne coupent pas.
- **routes-access.ts** : invitations (QR), `me`, `logout`, gestion des appareils (rôle, espaces, retrait en cascade par une requête SQL récursive).
- **routes-points.ts** : création et modification des points, `normalize()`, photos, problèmes, « toujours là », participation et matériel, blocus et blocages, flash, tâches planifiées.
- **routes-votes.ts** : tables et routes des votes, partie app et partie publique (code, distance haversine, vote ouvert à tous).
- **routes-archive.ts** : archive, envoi de fichiers en deux temps, registre, partie publique (documents, prochaines AG).
- **routes-chat.ts** : clés publiques, époques, enveloppes, messages chiffrés, 409 si l'époque est périmée, rétention de 30 jours.
- **backup.ts** : sauvegarde cohérente avec `VACUUM INTO`, copie des photos, rotation.
- **cli-invite.ts** : `npm run invite-admin` crée une invitation propriétaire de secours.

### web/src/
- **main.ts** : démarrage.
  - Routage par hash : `#/vote`, `#/public`, `#/join/<jeton>`.
  - Écran verrouillé (page publique) ou application.
  - Construit la barre, les onglets et les filtres.
  - Écoute le flux SSE et filtre les notifications.
- **ui.ts** : boîte à outils.
  - `h(tag, attributs, ...enfants)` crée un élément DOM ; le texte est **toujours échappé**, ce qui protège des injections XSS.
  - `icon()`, `toast()`, formatage des dates en français, `inkFor()` (texte clair ou foncé selon le fond).
- **store.ts** : l'état global du client (appareil, espace, points, filtres, votes ouverts).
  - Petit système d'abonnement `on`/`emit` : un écran s'abonne à `'points'` et se redessine quand on émet `'points'`.
- **api.ts** : toutes les requêtes HTTP. `req()` gère les erreurs (`ApiError`) et la déconnexion (401). `compressImage` redimensionne les photos, ce qui **retire les données EXIF** (position GPS).
- **map.ts** : la carte.
  - Épingles en HTML (`divIcon`), avec une forme par mode : goutte = point fixe, carré à pointe = événement, éclair = flash.
  - États : participation en violet, badge de vote.
  - Filtres et viseur pour placer un point.
- **basemap.ts** : fond vectoriel recoloré par espace ; repli sur les tuiles images OSM sans WebGL.
- **detail.ts** : fiche d'un point, avec toutes ses actions.
- **forms.ts** : formulaires (point, alerte rapide) et composants (`chips`, `segmented`, `field`).
- **agenda.ts** : semaine en cours, filtres Tout / Événements / Flash, bandeau « Votes en cours ».
- **votes.ts** : section Votes d'une AG, lancement d'un vote, écran du code façon Kahoot, vote dans l'app, page publique de vote par code.
- **archive.ts** : frise de l'archive, formulaire d'ajout ; `itemCard` et `timeline` sont réutilisés par `home.ts`.
- **home.ts** : page publique sans compte (votes indicatifs, prochaines AG, archive publique).
- **chat.ts / chat-crypto.ts** : interface du chat, et crypto pure (aucun appel réseau dans `chat-crypto.ts`).
- **team.ts** : onglet Équipe (invitations QR, liste des appareils, droits).
- **route.ts + optimize.ts** : tournée de collage. Ordre calculé par « plus proche voisin » puis amélioré par « 2-opt » ; export Google Maps, Waze, GPX.
- **geo.ts** : GPS, distance haversine, temps de marche.
- **sheet.ts** : fenêtre glissante du bas (modale) et confirmation.
- **styles.css** : toute l'apparence.
  - Les couleurs sont des **variables CSS** sur `:root`.
  - Le thème Mouvement les redéfinit sous `:root[data-space='mvt']`, et `main.ts` règle `data-space` sur `<html>`.

## 7. Les motifs de code qui reviennent partout

**Créer de l'interface avec `h()`**
```ts
h('button', { class: 'btn', onclick: () => go() }, icon('plus', 18), 'Créer')
```
Cela produit `<button class="btn">` avec une icône et le texte « Créer ». Un enfant `null` est ignoré, ce qui permet d'écrire `condition ? h(...) : null`.

**Redessiner en entier**
Les écrans n'actualisent pas finement le DOM : à chaque changement, `render()` vide le conteneur (`clear(root, ...)`) et reconstruit tout. C'est simple et sans bug d'état, mais un peu coûteux (voir l'autocritique).

**Une route serveur typique** (exemple simplifié)
```ts
points.post('/points/:id/participate', (req, res) => {
  const p = pointFor(req, req.params.id);          // 404 si absent ou autre espace
  if (!p) return res.status(404).json({ error: '…' });
  const body = schema.parse(req.body);              // zod : lève une erreur → 400
  db.prepare('INSERT …').run(...);                 // requête préparée : pas d'injection SQL
  broadcast('points', { id: p.id }, p.space);       // prévient les autres appareils
  res.json({ point: toDto(p) });
});
```

**Requêtes SQL préparées**
Les valeurs passent toujours par des `?` et ne sont jamais collées dans le texte SQL. C'est ce qui empêche l'injection SQL.

**`as unknown as Row`**
`node:sqlite` renvoie des objets « inconnus ». On dit à TypeScript quelle forme ils ont. C'est une promesse non vérifiée, donc à manier avec prudence.

## 8. Lancer, tester, déployer

- Dev : lance `npm run dev` (serveur sur le port 3180, Vite sur le port 5180), puis ouvre http://localhost:5180.
- Vérifier les types : `npm run typecheck`. Il n'y a **pas de tests automatisés** (voir l'autocritique).
- Créer un accès propriétaire : `npm run invite-admin`.
- Production : voir [DOCKER.md](../DOCKER.md) (Docker, la voie prévue) ou [DEPLOIEMENT.md](../DEPLOIEMENT.md) (VPS avec systemd).

## 9. Petit glossaire

- **SSE** : connexion HTTP qui reste ouverte, par laquelle le serveur envoie des messages.
- **CSRF** : attaque où un autre site déclenche une action avec ton cookie. Parade : exiger l'en-tête `X-Terrain`, qu'un autre site ne peut pas ajouter.
- **CSP** : liste, envoyée par le serveur, des sources de scripts, styles et images autorisées. Elle limite les dégâts d'une injection.
- **Middleware** : fonction Express qui s'exécute avant la route (vérifier le cookie, lire le JSON…).
- **Haversine** : formule de distance entre deux points GPS sur une sphère.
- **ECDH** : deux appareils calculent un secret commun à partir de leurs clés, sans jamais l'envoyer.
- **HKDF** : transforme ce secret brut en une clé propre et dédiée à un usage.
- **AES-GCM** : chiffrement qui détecte aussi toute modification. L'**IV** est un nombre aléatoire à ne jamais réutiliser avec la même clé.
- **WAL** : mode de SQLite qui permet de lire pendant qu'on écrit.
- **PWA** : site installable sur l'écran d'accueil du téléphone.
