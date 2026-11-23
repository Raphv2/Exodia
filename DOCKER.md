# Héberger Terrain avec Docker

Notice pour la personne qui héberge l'app sur son serveur.

**Prérequis** : Docker avec Compose v2 (`docker compose version`), sur n'importe quelle machine Linux, NAS compris. L'image est construite pour l'architecture de la machine : PC (x86) comme Raspberry Pi (ARM).

## 1. Récupérer et lancer

```bash
git clone https://github.com/Raphv2/lfiMap.git terrain
cd terrain
```

**D'abord, le fichier `.env`** (le domaine n'est écrit en dur nulle part, compose refuse de démarrer sans lui) :
```bash
cp .env.example .env
nano .env        # DOMAIN=carte.raphaelgosset.fr (ou le domaine choisi)
```
Le fichier règle aussi le fuseau horaire (`TZ=Europe/Paris` par défaut) et l'heure des sauvegardes.

**Cas A — tu as déjà un reverse proxy HTTPS** (Nginx, Traefik, Nginx Proxy Manager, Caddy…) :
```bash
docker compose up -d --build
```
L'app écoute sur `127.0.0.1:3180`. Relie-la à ton proxy (voir section 3). Pour changer le port côté hôte : `TERRAIN_PORT=3190`.

**Cas B — rien n'occupe les ports 80/443** : Caddy est fourni et obtient le certificat HTTPS tout seul.
```bash
docker compose --profile caddy up -d --build
```

## 2. Serveur à la maison : rendre l'app joignable

1. **IP publique de la box** : regarde sur https://ifconfig.me depuis le réseau de la maison.
   - Pour une IP **fixe** (cas habituel en fibre chez Free, Orange, SFR ou Bouygues), crée l'enregistrement DNS une fois pour toutes.
   - Pour une IP **dynamique**, il faut un client DNS dynamique, ou passer par un tunnel (voir plus bas).
   - Pour une IP **partagée** (CGNAT, parfois chez Free en IPv4 : demande une « IP fullstack » dans l'espace abonné), le transfert de ports est impossible. Passe alors par un tunnel.
2. **DNS** : dans hPanel (Hostinger), domaine `raphaelgosset.fr` → enregistrement **A**, nom `carte`, valeur = l'IP publique de la box. Ne touche à aucun autre enregistrement.
3. **Box** : redirige les ports **TCP 80 et 443** (et UDP 443 si possible) vers l'IP locale du serveur. Donne une IP locale fixe au serveur (bail DHCP statique).
4. Vérifie depuis un téléphone **en 4G**, Wi-Fi coupé : `https://carte.raphaelgosset.fr`.

**Sans ouvrir de ports** : un tunnel Cloudflare (`cloudflared`) fonctionne aussi. Il impose de déléguer le DNS du domaine à Cloudflare, ce qui concerne aussi le site principal de Raphaël. Ce choix se fait avec lui.

## 3. Brancher un reverse proxy existant (cas A)

Points importants pour l'app :
- Le **temps réel** passe par `/api/stream` (Server-Sent Events). Le proxy ne doit **pas** mettre les réponses en mémoire tampon, et doit garder la connexion ouverte longtemps.
- L'en-tête `X-Forwarded-Proto: https` doit être transmis : les cookies de session sont marqués `Secure`.

**Nginx** :
```nginx
server {
    server_name carte.raphaelgosset.fr;
    # … listen 443 ssl + certificats (certbot) …
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:3180;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

**Nginx Proxy Manager** : Forward Hostname/IP = IP de l'hôte (ou `terrain` si NPM est sur le même réseau Docker), port `3180`, active « Websockets Support », demande un certificat SSL. Dans l'onglet *Advanced*, ajoute :
```
proxy_buffering off;
proxy_read_timeout 1h;
client_max_body_size 20m;
```

**Traefik** : retire la section `ports:` du service `terrain` et ajoute tes labels habituels, avec le port de service `3180`. Le SSE fonctionne sans réglage particulier.

## 4. Premier admin

Au premier démarrage, l'app affiche un lien d'invitation admin (24 h, usage unique) :
```bash
docker compose logs terrain | grep join
```
Envoie ce lien **à Raphaël**, qui l'ouvre sur son téléphone : son appareil devient l'admin.

Lien perdu :
```bash
docker compose exec terrain npm run invite-admin -- https://carte.raphaelgosset.fr
```

## 5. Mettre à jour

```bash
cd terrain
git pull
docker compose up -d --build          # (+ --profile caddy en cas B)
```
Les données sont dans le volume `terrain-data` : elles survivent aux mises à jour et aux reconstructions.

## 6. Sauvegardes

**Automatiques** : le conteneur `terrain-backup` (lancé avec les autres) fait une copie cohérente de la base et des fichiers au démarrage, puis chaque nuit à 4 h (`BACKUP_HOUR`). Il garde 14 jours (`BACKUP_DAYS`), dans le volume `terrain-backups`.
```bash
docker compose logs backup        # « Sauvegarde : /backups/2026-… » chaque nuit
```

**Indispensable : copier ces sauvegardes sur un AUTRE disque** (le volume est sur le même disque que les données : si le disque meurt, tout part avec). Par exemple chaque nuit à 5 h, avec `crontab -e` sur l'hôte (adapte les chemins) :
```
0 5 * * * cd /chemin/vers/terrain && docker compose cp backup:/backups /mnt/autre-disque/sauvegardes-terrain
```
Sauvegarde immédiate, à la main :
```bash
docker compose exec -T backup node --import tsx server/backup.ts /backups 14
```
Copier les sauvegardes sur l'hôte :
```bash
docker compose cp backup:/backups ./sauvegardes-terrain
```

**Restaurer** (remplace `<date>` par le dossier de la sauvegarde) :
```bash
docker compose stop terrain
docker compose run --rm --no-deps -u root \
  -v "$PWD/sauvegardes-terrain/<date>:/restore:ro" terrain \
  sh -c 'rm -f /data/terrain.db /data/terrain.db-wal /data/terrain.db-shm && cp /restore/terrain.db /data/ \
         && rm -rf /data/uploads && cp -r /restore/uploads /data/ && chown -R node:node /data'
docker compose start terrain
```

## 7. Dépannage

| Symptôme | À faire |
|---|---|
| Rien ne répond | `docker compose ps` (état *healthy* ?) puis `docker compose logs -f terrain` |
| Erreur de certificat (cas B) | DNS ou ports 80/443 non redirigés : `docker compose logs caddy` |
| Les alertes n'arrivent pas en direct | Le proxy met `/api/stream` en tampon : `proxy_buffering off` (section 3) |
| Envoi de photo ou de document refusé (413) | Limite de taille du proxy : `client_max_body_size 20m` |

**Confidentialité** : la personne qui héberge a accès aux données (base, photos). C'est normal pour un hébergeur, autant le savoir.
