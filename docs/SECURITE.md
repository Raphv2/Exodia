# Note de sécurité de Terrain

Cette note liste chaque protection, ce qu'elle empêche et le fichier où elle se trouve. Le détail est expliqué en commentaires dans le code.

## Accès et comptes

| Protection | Ce qu'elle empêche | Où |
|---|---|---|
| Accès uniquement sur invitation (QR) ; pas de mot de passe, l'appareil sert de compte | Inscriptions sauvages | `server/routes-access.ts` (`/auth/claim`) |
| Jeton de session dans un cookie `httpOnly`, `SameSite=strict`, `Secure` en HTTPS ; la base n'en stocke que le SHA-256 | Vol du jeton par du JavaScript ; une fuite de la base ne donne pas les jetons | `server/auth.ts` (`setSessionCookie`, `requireDevice`) |
| Anti-CSRF : en-tête `X-Terrain` obligatoire sur toute écriture | Qu'un autre site agisse avec ton cookie | `server/auth.ts` (`csrf`) |
| Invitation vérifiée et consommée dans une seule transaction | Utiliser deux fois une invitation à usage unique | `server/routes-access.ts` (`tx`) |
| Rôles : propriétaire, admin, relais, membre (`canManage`) | Qu'un admin gère quelqu'un hors de ses espaces ou nomme d'autres admins | `server/routes-access.ts` |
| Un seul propriétaire ; l'invitation de secours lui transfère la propriété | Deux propriétaires en même temps | `routes-access.ts` (claim), `server/cli-invite.ts` |
| Le dernier admin et le propriétaire ne peuvent pas se déconnecter | Se retrouver sans administrateur | `routes-access.ts` (`/auth/logout`, `PATCH /devices`) |
| Retrait en cascade : appareils, invitations ouvertes, flux temps réel coupé | Un appareil retiré qui garde un accès | `routes-access.ts` (`DELETE /devices`), `server/events.ts` (`disconnect`) |

## Étanchéité Campagne / Mouvement

| Protection | Où |
|---|---|
| Chaque point a un espace ; un point d'un autre espace répond 404, comme s'il n'existait pas | `server/routes-points.ts` (`pointFor`, `GET /points` filtré en SQL) |
| Les types n'existent que d'un côté (`typeInSpace`) | `shared/model.ts` |
| Le temps réel n'envoie qu'aux appareils de l'espace concerné (espace obligatoire) | `server/events.ts` (`broadcast`) |
| L'archive et le chat sont réservés au Mouvement | `server/routes-archive.ts`, `server/routes-chat.ts` (`requireMvt`) |

## Fichiers envoyés (photos, archive)

| Protection | Où |
|---|---|
| Le type est reconnu d'après le contenu (« magic bytes »), jamais d'après le nom ; le fichier reçoit un nom aléatoire | `routes-points.ts` et `routes-archive.ts` (`sniff`) |
| Métadonnées retirées : EXIF/GPS des JPEG et PNG, auteur et logiciel des PDF (au mieux) | `server/sanitize.ts`, et la recompression dans `web/src/api.ts` (`compressImage`) |
| Un fichier ne peut être rattaché que par l'appareil qui l'a envoyé, et à un seul élément (index UNIQUE) | `server/uploads.ts` |
| Fichier pas encore rattaché : visible seulement par l'appareil qui l'a envoyé | `routes-points.ts` (`GET /photos`), `routes-archive.ts` |
| Documents servis en téléchargement, avec `nosniff`, une CSP `sandbox` et `no-cache` | `routes-archive.ts` (`GET /archive/files`) |
| Fichiers orphelins effacés après 24 h | `cleanup`, `cleanupArchive` |

## Votes d'AG

| Protection | Où |
|---|---|
| Un bulletin par votant, garanti par la base (clé primaire) | `server/routes-votes.ts` (`cast`) |
| Présence vérifiée par GPS si le vote a un rayon ; la distance exacte n'est jamais révélée | `routes-votes.ts` (`presenceError`) |
| Codes faux limités à 20 par 10 min et par IP ; limite par votant ; filet de sécurité large par IP | `routes-votes.ts` (limiteurs), `server/auth.ts` (`rateLimit`) |
| Résultat public visible seulement par qui a voté, ou pour une AG publique | `routes-votes.ts` (`/votes/:id/result`) |
| Clôture automatique après l'AG | `routes-votes.ts` (`closeStaleVotes`) |
| Votes sans compte affichés « indicatifs » (on peut revoter en navigation privée) | `web/src/home.ts`, `web/src/votes.ts` |

## Chat chiffré de bout en bout

| Protection | Où |
|---|---|
| Clé d'appareil ECDH P-256 non exportable, rangée dans IndexedDB ; le serveur ne voit que la clé publique | `web/src/chat-crypto.ts` (`deviceKeys`) |
| Clé de groupe AES-256 par époque, envoyée à chaque membre dans une enveloppe (ECDH, puis HKDF, puis AES-GCM) | `chat-crypto.ts` (`newEpoch`, `openEpoch`) |
| Messages en AES-GCM, liés à l'époque et à l'expéditeur ; identifiant et heure chiffrés pour bloquer le rejeu | `chat-crypto.ts` (`encryptMessage`) |
| Nouvelle époque à chaque changement de membres et au moins chaque semaine ; le serveur refuse une époque périmée (409) | `web/src/chat.ts` (`epochUpToDate`), `server/routes-chat.ts` |
| Liste des clés déjà vues, avec alerte si un membre apparaît ou change de clé ; codes de sécurité à comparer de vive voix | `chat.ts` (`updateTrust`, `openMembers`) |
| Seule une époque créée par un membre connu est acceptée | `chat-crypto.ts` (`openEpoch`) |
| Messages effacés au bout de 30 jours ; nombre de messages limité par appareil | `routes-chat.ts` |

**Limite à connaître :** si le serveur est piraté, il peut glisser un faux membre. Seule la comparaison des codes de sécurité le révèle. Il n'y a pas non plus de confidentialité persistante complète, comme le « double ratchet » de Signal.

## Navigateur et réseau

| Protection | Où |
|---|---|
| CSP stricte : pas de script ni de style en ligne, sources limitées | `server/index.ts` |
| HSTS en HTTPS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` | `server/index.ts` |
| Le texte est toujours inséré comme texte, jamais comme HTML (y compris les épingles de la carte) | `web/src/ui.ts` (`h()`), `web/src/map.ts` |
| Toutes les entrées sont validées par zod ; les requêtes SQL sont toujours paramétrées (`?`) | Toutes les routes de `server/` |
| Réglage `trust proxy` explicite, pour lire la vraie IP derrière Caddy ou Nginx | `server/index.ts` |
| Erreurs : message générique pour le client, détail seulement dans les journaux du serveur | `server/index.ts` |

## Hébergement

| Protection | Où |
|---|---|
| L'app n'écoute que sur 127.0.0.1 ; HTTPS fourni par Caddy | `docker-compose.yml`, `deploy/Caddyfile*` |
| Conteneur non root ; service systemd durci | `Dockerfile`, `deploy/terrain.service` |
| Sauvegardes quotidiennes cohérentes, conservées 14 jours. **À copier sur un autre disque** | `server/backup.ts`, service `backup` dans `docker-compose.yml` |
| Fuseau horaire fixé (`TZ=Europe/Paris`) | `Dockerfile`, `.env.example` |
| Aucun secret dans le dépôt : domaine et réglages dans `.env` | `.env.example`, `.gitignore` |

## Tests

`npm test` vérifie l'étanchéité des espaces, le vol de fichier, le nettoyage des métadonnées, l'unicité du vote, la limite des codes faux et les règles du propriétaire et du dernier admin. Les tests sont dans `tests/`.
