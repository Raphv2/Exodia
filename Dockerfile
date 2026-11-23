# syntax=docker/dockerfile:1

# Recette de l'image Docker : l'autre façon d'installer Terrain (la première étant
# deploy/install.sh sur un VPS). Utilisée par docker-compose.yml (« build: . »).
# Construction en deux étapes (« multi-stage ») : une image de compilation jetable,
# puis une image finale qui ne garde ni les outils de développement ni les sources de l'interface.
# La ligne 1 (syntax=...) est une directive pour BuildKit : elle doit rester tout en haut.
#
# ---- Étape 1 : compilation de l'interface ----
# Image de départ : Node 22 sur Debian 12 « bookworm », version allégée (slim).
# Version ÉPINGLÉE (22.23) : la même image à chaque construction, pas de saut de version surprise.
# Les correctifs 22.23.x arrivent en reconstruisant avec --pull. Pour changer de version, modifier
# le numéro ici ET dans l'étape finale plus bas (minimum 22.13, voir « engines » de package.json).
# « AS build » donne un nom à cette étape pour y piocher plus tard.
FROM node:22.23-bookworm-slim AS build
# Dossier de travail dans l'image (créé s'il n'existe pas) ; les commandes suivantes s'y exécutent.
WORKDIR /app
# On copie d'abord SEULEMENT la liste des dépendances : tant qu'elle ne change pas, Docker
# réutilise le résultat en cache de l'étape npm ci suivante (reconstruction bien plus rapide).
COPY package.json package-lock.json ./
# npm ci : installe exactement les versions de package-lock.json, dépendances de développement
# comprises (Vite est nécessaire pour compiler). Sans audit ni message de financement.
RUN npm ci --no-audit --no-fund
# Copie tout le projet dans l'image, sauf ce qu'exclut .dockerignore.
COPY . .
# Compile l'interface (vite build) dans /app/dist/web.
RUN npm run build

# ---- Étape 2 : image finale, légère ----
# Étape finale : on repart d'une image propre. Rien de l'étape « build » n'est gardé,
# sauf ce qu'on recopie explicitement plus bas (COPY --from=build).
# Même version épinglée que l'étape de compilation.
FROM node:22.23-bookworm-slim
# Variables d'environnement lues par le serveur : mode production ; écoute sur toutes les
# interfaces DU CONTENEUR (0.0.0.0, sinon injoignable depuis l'extérieur du conteneur) ;
# port 3180 ; données dans /data ; TRUST_PROXY=1 = un proxy (Caddy) est devant, l'app
# lit donc l'adresse IP réelle du visiteur dans l'en-tête X-Forwarded-For.
# TZ=Europe/Paris : heure locale du serveur. Indispensable : les événements répétés « chaque jour
# à 18 h » et la fin des blocus sont calculés en heure locale. Sans TZ, le conteneur serait en UTC
# (1 à 2 h de décalage). Node embarque ses propres données de fuseaux : pas besoin de tzdata.
ENV NODE_ENV=production \
    TZ=Europe/Paris \
    HOST=0.0.0.0 \
    PORT=3180 \
    DATA_DIR=/data \
    TRUST_PROXY=1
WORKDIR /app

# Dépendances de production seulement (--omit=dev). tsx en fait partie : c'est lui qui
# exécute le serveur écrit en TypeScript. Le cache npm est vidé pour alléger l'image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Code du serveur et code partagé, puis l'interface déjà compilée, prise dans l'étape build.
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist/web ./dist/web

# Données persistantes (base SQLite + photos + sauvegardes) : à monter en volume.
# Le dossier appartient à « node », utilisateur sans privilèges fourni par l'image officielle.
# /backups : dossier des sauvegardes (service « backup » de docker-compose.yml).
RUN mkdir -p /data /backups && chown node:node /data /backups
# VOLUME : /data est un dossier à conserver en dehors du conteneur (survit aux mises à jour).
VOLUME ["/data"]
# À partir d'ici, tout (et l'app elle-même) tourne sans les droits root.
USER node

# Documente le port écouté. Cela ne publie rien : c'est « ports » dans docker-compose.yml qui le fait.
EXPOSE 3180
# Bilan de santé : toutes les 30 s, Docker interroge /api/health (fetch de Node, pas besoin de
# curl dans l'image). Cette route répond 200 seulement si l'app tourne ET que sa base répond
# (503 sinon). Après 3 échecs, le conteneur est marqué « unhealthy ».
# start-period : 20 s de grâce au démarrage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3180/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Commande de démarrage : Node charge tsx (--import) pour exécuter directement le TypeScript,
# et masque l'avertissement « fonction expérimentale » de node:sqlite.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "server/index.ts"]
