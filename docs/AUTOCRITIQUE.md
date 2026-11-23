# Autocritique du code de Terrain

J'ai écrit ce code, et voici, sans complaisance, ce qui ne va pas ou pourrait mal tourner.
J'ai **relu tout le code** pour l'écrire, mais **je n'ai rien corrigé**. Les numéros de ligne renvoient aux fichiers **commentés**.

Classement :
- 🔴 à corriger avant un vrai déploiement ;
- 🟠 problème réel mais limité ;
- 🟡 dette ou confort.

---

## 0. Le constat global

- **Aucun test automatisé.** Tout a été vérifié à la main : appels d'API en ligne de commande et clics dans le navigateur, au fil des demandes. Chaque nouvelle fonctionnalité peut donc casser une ancienne sans que personne ne s'en aperçoive. C'est le plus gros défaut du projet.
- **Développé vite, par ajouts successifs.** Les fonctionnalités se sont empilées : blocus, puis flash, puis deux espaces, puis votes, archive, chat… Il en reste :
  - des fichiers trop longs (`forms.ts`, `routes-points.ts`, `main.ts`) ;
  - un CSS de plus de 1300 lignes qui s'allonge par le bas ;
  - des règles dupliquées.
- **Pas de transactions SQL** dans les écritures en plusieurs étapes, ni dans les migrations. Un plantage au mauvais moment laisserait la base à moitié modifiée.

## 1. 🔴 À corriger avant le déploiement

| # | Problème | Où | Conséquence |
|---|---|---|---|
| 1 | **Fuseau horaire.** Le conteneur Docker tourne en UTC, et rien ne fixe `TZ=Europe/Paris`. | `docker-compose.yml`, `shared/time.ts` | Les événements répétés et `releaseBlocages` se décalent d'une à deux heures côté serveur. |
| 2 | **Pas de sauvegarde planifiée en Docker.** `backup.ts` n'est lancé automatiquement que dans l'installation systemd. | `docker-compose.yml` | Disque mort = tout perdu : AG, archive, votes. |
| 3 | **Fichiers partagés entre deux éléments.** On peut créer un point ou un élément d'archive qui pointe vers le fichier d'un autre. | `routes-points.ts` (photos), `routes-archive.ts:252` | Supprimer l'un efface le fichier de l'autre. Un document **privé** peut être rendu **public** en le référençant depuis un élément public. |
| 4 | **Résultats de vote lisibles par tous.** `GET /api/public/votes/:id/result` ne fait aucun contrôle. | `routes-votes.ts:461` | Qui connaît l'id voit la question et les résultats, même d'une AG interne. L'id est aléatoire, donc l'impact reste faible, mais c'est contraire à l'intention. |
| 5 | **Limite de débit par adresse IP.** Toute une AG sur le même Wi-Fi partage la même IP. | `auth.ts` (`rateLimit`) | En pleine AG, des personnes peuvent recevoir « trop de requêtes » (15 par minute pour toute la salle). |
| 6 | **Domaine personnel écrit en dur.** | `docker-compose.yml`, `deploy/install.sh` | À remplacer avant de déployer chez ton ami. |

## 2. 🟠 Sécurité

- **Chat : protégé contre un serveur curieux, pas contre un serveur malveillant.**
  - C'est la limite la plus importante. Le serveur fournit la liste des membres et leurs clés publiques, et le client lui fait confiance (`chat.ts:90`, `chat-crypto.ts:227`).
  - Quelqu'un qui contrôle le serveur pourrait glisser sa propre clé comme faux membre : les clients chiffreraient alors aussi pour lui.
  - La seule parade est de **comparer les codes de sécurité de vive voix**, pour **tous** les membres. Signal fait pareil, mais l'affiche bien plus clairement.
- **Chat : pas de confidentialité persistante.** Les clés d'appareil ne changent pas. Une clé volée, par exemple via une faille XSS, ouvre toutes les enveloppes encore stockées (30 jours).
- **Chat : rejeu de messages.** Les données authentifiées ne contiennent ni l'id ni la date du message. Le serveur peut dupliquer un message ou en changer l'heure sans que les clients le voient.
- **Deviner si un code de vote est valide.** Pour la recherche par code, un code faux donne 404 alors qu'un bon code sans position donne 428. On peut donc savoir qu'un code existe sans être sur place. La limite de débit freine, sans empêcher.
- **Deux propriétaires possibles.** Relancer `npm run invite-admin` alors qu'un propriétaire existe en crée un second (`routes-access.ts:115`).
- **Le dernier admin peut se déconnecter** (`logout`, `routes-access.ts:159`). Il n'y a alors plus d'administrateur jusqu'au prochain redémarrage.
- **Changement d'espaces à moitié appliqué.** `PATCH /devices` enregistre les espaces avant de vérifier qu'il reste au moins un admin (`routes-access.ts:324`). Une erreur laisse donc la modification à moitié faite.
- **Métadonnées des fichiers.**
  - Les photos du client sont recompressées (sans EXIF, donc sans position GPS), mais le serveur ne vérifie pas que c'est le cas.
  - Les PDF de l'archive gardent leurs métadonnées (auteur, logiciel).
- **CSP avec `style-src 'unsafe-inline'`**, et **pas d'en-tête HSTS**.
- **Déploiement systemd** :
  - le code dans `/opt/terrain` appartient au compte de l'application ;
  - le lien d'invitation admin est écrit dans les journaux ;
  - `ufw allow OpenSSH` suppose que SSH écoute sur le port 22.

## 3. 🟠 Bugs repérés

- **Flux temps réel sans relance.** L'`EventSource` n'a pas d'`onerror`. Si le proxy renvoie une erreur 502, le direct s'arrête ; seul le rechargement des 5 minutes subsiste (`main.ts`, vers la ligne 430).
- **`JSON.parse` non protégé** dans les écouteurs SSE (`main.ts:436`, `:494`) et dans le registre de l'archive.
- **Erreurs non rattrapées dans les routes `async`.** Express 4 ne capture pas les erreurs des routes `async` (`POST /invites`). Une erreur y laisse la requête bloquée.
- **Écran de bienvenue.** La clé `terrain:welcomed` effacée n'est pas celle qu'utilise `welcome()`, qui ajoute l'espace à la fin (`main.ts:198` contre `:588`).
- **Bornes des listes.**
  - `LIMIT 100` s'applique avant le filtre par espace dans `/votes/open` : des votes peuvent manquer.
  - Le chat ne recharge que les 60 derniers messages : une rafale laisse des trous.
- **Message supprimé encore affiché.** Un message effacé reste visible chez les autres jusqu'au rechargement (`chat.ts:141`).
- **Répétitions.**
  - Mensuelle : le 31 janvier plus un mois donne le 3 mars.
  - Quotidienne : un « +24 h » est faux d'une heure lors du changement d'heure (`detail.ts:219`, `time.ts`).
- **Vote qui survit à son AG.** Si on change le type de l'AG, son vote reste ouvert. Aucun vote ne se ferme tout seul, même des jours après l'AG.
- **Couleur auto du blocus.** Elle n'est attribuée qu'à la création : un point modifié pour devenir un blocus n'en reçoit pas.
- **Diffusion partielle.** `releaseBlocages` ne diffuse que le premier blocage libéré (`routes-points.ts:798`).
- **Ménage qui peut planter.** `cleanup` et `cleanupArchive` appellent `statSync`, qui lève une erreur si un fichier disparaît pendant le parcours.
- **Archive.** La limite de 15 Mo s'applique avant la compression : une grosse photo est refusée alors qu'elle passerait une fois compressée.
- **Formulaire d'alerte.** « Sur la carte » perd le titre et la description déjà saisis (`forms.ts:745`).
- **Mémoire.**
  - Le limiteur de débit ne vide jamais sa table d'adresses IP : la mémoire grossit lentement.
  - Les adresses d'images (`createObjectURL`) ne sont jamais libérées.

## 4. 🟡 Performance (sans souci à l'échelle d'un groupe, à surveiller au-delà)

- **`GET /points`** charge les points de **tous** les espaces, avec tous leurs problèmes et engagements, puis filtre en JavaScript.
- **Carte.** `renderMarkers()` recrée **toutes** les épingles à chaque événement et chaque minute. Une infobulle ouverte se ferme.
- **Couleurs des blocages.** `paintOf` cherche le blocus parent dans toute la liste pour chaque blocage, ce qui coûte de plus en plus cher quand le nombre de points grandit.
- **Requêtes en série (N+1).**
  - Une ou deux requêtes par vote (`voteDto`).
  - Une requête SQL **par client connecté** à chaque diffusion (`events.ts`).
- **Tournée.** `optimize.ts` tourne dans le fil de l'interface. L'écran se fige au-delà de quelques centaines de points.
- **Répétitions.** `occurrences()` repart de la première séance à chaque calcul.

## 5. 🟡 Dette technique et lisibilité

- **Code mort.**
  - `publicArchivePage` (`archive.ts`) a été remplacée par `home.ts`.
  - La colonne `chat_epochs.members` n'est jamais relue.
  - `store.emit('me')` n'a aucun abonné.
- **Doublons dans le CSS** : `.splash`, `.btn:disabled`, `.chip`, `.seg`, `input[type=date]`, plusieurs media queries presque identiques, des couleurs écrites en dur au lieu des variables.
- **Événements du store non typés.** Ce sont des chaînes libres : une faute de frappe dans un nom d'événement passe inaperçue.
- **Conversions forcées.** Des `as unknown as`, `as never` et `any` contournent les vérifications de TypeScript.
- **Pas de numéro de version du schéma.** Les migrations sont déduites des colonnes présentes, et la conversion des blocages tourne à chaque démarrage.
- **Tables des votes hors de `db.ts`.** Elles sont créées dans `routes-votes.ts`, sans migration.
- **`tsconfig` unique** pour le serveur et le navigateur : le serveur pourrait utiliser `window` sans que le compilateur proteste.
- **Ma méthode de travail.** J'ai souvent modifié le code par des scripts de remplacement de texte (Python) plutôt que par une conception d'ensemble. C'était efficace pour aller vite, mais c'est ce qui a produit les doublons et les fichiers longs.

## 6. 🟡 UX discutable

- **Vote sans retour possible.** On vote d'un seul clic, sans confirmation, et le choix est définitif.
- **Couleur perdue en silence.** Changer de type remet la couleur personnalisée à zéro sans prévenir.
- **Confirmation qui ferme la fiche.** Comme une seule fenêtre peut être ouverte, demander une confirmation depuis une fiche ferme la fiche.
- **Pourcentages.** Arrondis, ils peuvent totaliser 99 % ou 101 %.
- **Tournée en voiture.** Le facteur de détour ×1,3 est aussi appliqué.
- **Accessibilité.** Le focus clavier n'est pas retenu dans les fenêtres modales.

## 7. Ce que je ferais en premier, dans l'ordre

1. Ajouter `TZ=Europe/Paris` et une **sauvegarde planifiée** dans `docker-compose.yml`. Remplacer le domaine écrit en dur. *(1 h)*
2. Corriger les **fichiers partagés**, en refusant un fichier déjà rattaché, et la **route de résultats publique**. *(1 h)*
3. Adapter le **limiteur de débit** aux AG : plus permissif sur le vote, avec un compteur par vote plutôt que par IP. *(30 min)*
4. Rendre le temps réel robuste : `onerror` avec reconnexion, `try/catch` autour des `JSON.parse`, enveloppe pour les routes `async`. *(1 h)*
5. Corriger les petits bugs de droits : dernier admin, propriétaire unique, `PATCH` atomique. *(1 h)*
6. Écrire des **tests** : droits et espaces, votes (code, distance, unicité), époques du chat, `occurrences()`. Le lanceur de tests intégré à Node (`node:test`) suffit, sans dépendance à ajouter. *(une demi-journée)*
7. Enlever le code mort et ranger le CSS par composant.
8. Si le groupe le veut, renforcer le chat : rendre les codes de sécurité plus visibles, avec une alerte quand la clé d'un membre change.
