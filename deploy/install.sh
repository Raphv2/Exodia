#!/usr/bin/env bash
# Installation de Terrain sur un VPS neuf (Ubuntu 24.04 ou Debian 12).
#
#   bash install.sh carte.exemple.fr
#
# Relançable sans risque : il met à jour ce qui existe déjà.
# Mode strict : -e arrête le script à la première erreur ; -u signale toute variable non
# définie ; -o pipefail fait échouer un enchaînement « a | b » si l'une des commandes échoue.
set -euo pipefail

# Paramètres : domaine (1er argument, mis en minuscules), dépôt GitHub (modifiable par la
# variable d'environnement GITHUB_REPO), dossiers du code, des données, des sauvegardes.
# Deux comptes système distincts :
#   - terrain        : fait TOURNER l'app ; il ne peut écrire que dans ses données ($DATA_DIR) ;
#   - terrain-deploy : POSSÈDE le code (/opt/terrain) ; il télécharge, installe et compile.
# Ainsi, même si l'app était piratée, elle ne pourrait pas réécrire son propre code.
DOMAIN="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
GITHUB_REPO="${GITHUB_REPO:-Raphv2/lfiMap}"
APP_DIR=/opt/terrain
DATA_DIR=/var/lib/terrain
BACKUP_DIR=/var/backups/terrain
APP_USER=terrain
DEPLOY_USER=terrain-deploy
DEPLOY_HOME=/var/lib/terrain-deploy

# say : affiche une étape en violet gras ; die : affiche une erreur en rouge et arrête.
# Les suites 033[...m sont des codes de couleur du terminal.
say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }
# Exécute une commande sous le compte qui possède le code (sa clé SSH GitHub est dans
# $DEPLOY_HOME/.ssh), ou sous le compte de l'app.
as_deploy() { runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" "$@"; }
as_app() { runuser -u "$APP_USER" -- env HOME="$DATA_DIR" "$@"; }

# Vérifications préalables : domaine fourni, droits root, système Debian/Ubuntu (apt-get présent).
[ -n "$DOMAIN" ] || die "indique le domaine. Exemple : bash install.sh carte.exemple.fr"
[ "$(id -u)" -eq 0 ] || die "lance ce script en root (ou avec sudo)."
command -v apt-get >/dev/null || die "ce script est prévu pour Ubuntu ou Debian."
# Le domaine doit ressembler à un nom de domaine : des « étiquettes » de lettres, chiffres et
# tirets séparées par des points, terminées par une extension en lettres (ex. carte.exemple.fr).
# Évite aussi qu'un caractère spécial ne casse les fichiers où le domaine est recopié.
LABEL='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
DOMAIN_RE="^($LABEL\.)+[a-z]{2,63}\$"
{ [[ "$DOMAIN" =~ $DOMAIN_RE ]] && [ "${#DOMAIN}" -le 253 ]; } \
  || die "« $DOMAIN » ne ressemble pas à un nom de domaine. Exemple : bash install.sh carte.exemple.fr"

# Compare l'adresse IP de ce serveur (celle utilisée pour joindre 1.1.1.1) à celle que le DNS
# donne pour le domaine. Simple avertissement : l'installation continue dans tous les cas.
say "Vérification du DNS de $DOMAIN"
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -z "$DNS_IP" ]; then
  echo "  $DOMAIN ne pointe encore nulle part. Le certificat HTTPS sera obtenu dès que le DNS sera à jour."
elif [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "  Attention : $DOMAIN pointe vers $DNS_IP mais ce serveur est $SERVER_IP."
  echo "  Corrige l'enregistrement A dans hPanel ; le HTTPS s'activera tout seul ensuite."
else
  echo "  OK : $DOMAIN → $SERVER_IP"
fi

# Paquets système : certificats, curl, gpg, git, pare-feu ufw, mises à jour de sécurité
# automatiques, et de quoi ajouter des dépôts signés. DEBIAN_FRONTEND : aucune question posée.
say "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22.13 minimum (node:sqlite sans option). Installé depuis le dépôt officiel NodeSource
# seulement s'il manque ou s'il est trop ancien. La clé GPG du dépôt est enregistrée à part et
# « signed-by » la limite à ce seul dépôt.
say "Node.js 22"
need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
echo "  $(node -v)"

# Caddy depuis son dépôt officiel (même principe de dépôt signé), s'il n'est pas déjà là.
say "Caddy (serveur web + HTTPS automatique)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# Deux comptes système sans shell de connexion (voir plus haut). Dossiers des données et des
# sauvegardes réservés au compte de l'app (0750 : rien pour les autres utilisateurs) ;
# dossier personnel du compte de déploiement (clé SSH, cache npm) réservé à lui seul (0700).
say "Utilisateurs système et dossiers"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DEPLOY_HOME" --no-create-home --shell /usr/sbin/nologin "$DEPLOY_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR" "$BACKUP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$DEPLOY_HOME"

# Installation faite par une ancienne version de ce script : le code appartenait au compte de
# l'app et la clé GitHub était rangée dans ses données. On rend le code au compte de déploiement
# et on y déplace la clé (déjà enregistrée sur GitHub : inutile de la recréer).
if [ -d "$APP_DIR/.git" ] && [ "$(stat -c %U "$APP_DIR")" != "$DEPLOY_USER" ]; then
  echo "  Migration : le code passe au compte $DEPLOY_USER."
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
fi
if [ -f "$DATA_DIR/.ssh/id_ed25519" ] && [ ! -f "$DEPLOY_HOME/.ssh/id_ed25519" ]; then
  echo "  Migration : la clé de déploiement GitHub passe au compte $DEPLOY_USER."
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$DEPLOY_HOME/.ssh"
  cp -a "$DATA_DIR/.ssh/." "$DEPLOY_HOME/.ssh/"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
  rm -rf "$DATA_DIR/.ssh"
fi

# Code : simple mise à jour s'il est déjà cloné. Sinon on teste si le dépôt est public ;
# s'il est privé, on crée une clé SSH de déploiement (propre au compte terrain-deploy) à
# ajouter à la main sur GitHub. Tout se fait sous le compte terrain-deploy, jamais sous root :
# les scripts d'installation des paquets npm ne tournent donc pas avec les pleins pouvoirs.
say "Code de l'application"
if [ -d "$APP_DIR/.git" ]; then
  as_deploy git -C "$APP_DIR" pull --ff-only
else
  if GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$GITHUB_REPO.git" >/dev/null 2>&1; then
    REPO_URL="https://github.com/$GITHUB_REPO.git"   # dépôt public
  else
    # Dépôt privé : clé de déploiement en lecture seule, propre à ce serveur.
    REPO_URL="git@github.com:$GITHUB_REPO.git"
    KEY="$DEPLOY_HOME/.ssh/id_ed25519"
    if [ ! -f "$KEY" ]; then
      install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$DEPLOY_HOME/.ssh"
      as_deploy ssh-keygen -q -t ed25519 -N '' -C "terrain@$DOMAIN" -f "$KEY"
    fi
    # Enregistre l'empreinte de github.com (sinon ssh demanderait confirmation), sans doublon (sort -u).
    as_deploy bash -c "ssh-keyscan -t ed25519 github.com 2>/dev/null >> '$DEPLOY_HOME/.ssh/known_hosts'; sort -u -o '$DEPLOY_HOME/.ssh/known_hosts' '$DEPLOY_HOME/.ssh/known_hosts'"
    # Tant que GitHub refuse l'accès : affiche la clé publique et attend que l'on appuie sur Entrée.
    until as_deploy git ls-remote "$REPO_URL" >/dev/null 2>&1; do
      echo
      echo "  Le dépôt $GITHUB_REPO est privé. Autorise ce serveur à le lire :"
      echo "    1. Ouvre https://github.com/$GITHUB_REPO/settings/keys/new"
      echo "    2. Title : serveur $DOMAIN"
      echo "    3. Key : colle la ligne ci-dessous (NE coche PAS « Allow write access »)"
      echo
      echo "  $(cat "$KEY.pub")"
      echo
      read -r -p "  Appuie sur Entrée une fois la clé ajoutée… " _
    done
    echo "  Accès au dépôt : OK"
  fi
  # Dossier du code appartenant au compte de déploiement (lisible, mais PAS modifiable, par
  # le compte de l'app : droits 755), puis clonage du dépôt.
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$APP_DIR"
  as_deploy git clone --quiet "$REPO_URL" "$APP_DIR"
fi

# Installe les dépendances exactes (celles de développement comprises, pour Vite) et compile
# l'interface, sous le compte de déploiement (cache npm dans son dossier personnel).
# umask 022 : fichiers lisibles par tous (donc par le compte de l'app), modifiables par lui seul.
say "Dépendances et compilation de l'interface"
as_deploy bash -c "umask 022 && cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent"

# Installe les services systemd (en y mettant le domaine), les active au démarrage,
# lance l'app et le minuteur de sauvegarde quotidienne.
say "Services (démarrage automatique, sauvegarde quotidienne)"
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/terrain.service" > /etc/systemd/system/terrain.service
cp "$APP_DIR/deploy/terrain-backup.service" "$APP_DIR/deploy/terrain-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet terrain.service terrain-backup.timer
systemctl restart terrain.service
systemctl start terrain-backup.timer

# Caddy : garde une copie de l'ancien Caddyfile s'il ne vient pas de Terrain, écrit le
# nouveau, le valide (le script s'arrête s'il est invalide), puis recharge Caddy.
say "Caddy → https://$DOMAIN"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "Terrain" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.avant-terrain"
fi
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

# Pare-feu : n'autorise que SSH, HTTP (80) et HTTPS (443, TCP et UDP pour HTTP/3),
# puis l'active. Le fichier 20auto-upgrades active les mises à jour automatiques quotidiennes.
say "Pare-feu et mises à jour de sécurité automatiques"
# Port(s) SSH réellement utilisé(s) : ceux de la configuration de sshd (sshd -T l'affiche en
# entier, ligne « port 22 »), plus celui de la connexion SSH en cours (4e champ de
# $SSH_CONNECTION). Repli : 22. Ils sont autorisés AVANT d'activer le pare-feu, sinon on
# risquerait de se couper soi-même l'accès au serveur (port SSH changé, par exemple 2222).
SSH_PORTS="$( { sshd -T 2>/dev/null | awk '/^port /{print $2}'; echo "${SSH_CONNECTION:-}" | awk 'NF>=4{print $4}'; } | grep -E '^[0-9]+$' | sort -un || true)"
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
for port in $SSH_PORTS; do
  ufw allow "$port/tcp" comment 'SSH' >/dev/null
  echo "  SSH autorisé sur le port $port"
done
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

# Attend jusqu'à 30 s que l'app réponde en local sur /api/health (200 = l'app tourne ET sa
# base répond), puis vérifie aussi que le service est actif.
say "Vérification"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3180/api/health; then healthy=1; break; fi
  sleep 1
done
{ [ "$healthy" -eq 1 ] && systemctl is-active --quiet terrain; } \
  || die "l'application ne démarre pas. Regarde : journalctl -u terrain -n 50"
echo "  Application : en marche"

# Lien pour devenir admin, seulement s'il n'existe encore aucun admin actif (on interroge la
# base avec le module SQLite de Node, sous le compte de l'app). Le lien est fabriqué ici même
# par « npm run invite-admin » et affiché UNIQUEMENT dans ce terminal : il ne passe pas par
# les journaux (journalctl est lisible par d'autres comptes, ceux du groupe adm).
# Fait APRÈS le dernier redémarrage de l'app : à chaque démarrage sans admin, l'app annule les
# anciens liens « premier admin », celui-ci compris.
# Remarque : au premier démarrage, l'app écrit AUSSI un lien (valable 24 h) dans son journal.
# Il reste valable jusqu'à son expiration ou jusqu'à ce qu'un appareil devienne admin.
HAS_ADMIN=1
cd "$APP_DIR"   # dossier courant lisible par le compte de l'app (celui de root ne l'est pas)
as_app node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  const row = db.prepare("SELECT 1 FROM devices WHERE role = ? AND revoked_at IS NULL LIMIT 1").get("admin");
  process.exit(row ? 0 : 1);
' "$DATA_DIR/terrain.db" 2>/dev/null || HAS_ADMIN=0
LINK=""
if [ "$HAS_ADMIN" -eq 0 ]; then
  # Cache npm jetable réservé au compte de l'app ; umask 077 comme le service (fichiers privés).
  NPM_TMP="$(mktemp -d)"
  chown "$APP_USER:$APP_USER" "$NPM_TMP"
  LINK="$(as_app DATA_DIR="$DATA_DIR" TZ=Europe/Paris npm_config_cache="$NPM_TMP" \
    bash -c "umask 077 && cd '$APP_DIR' && npm run --silent invite-admin -- 'https://$DOMAIN'" \
    | grep -o "https://$DOMAIN/#/join/[A-Za-z0-9_-]*" | tail -n 1 || true)"
  rm -rf "$NPM_TMP"
fi

# Récapitulatif final.
echo
echo "────────────────────────────────────────────────────────────────────────"
echo "  Terrain est installé : https://$DOMAIN"
if [ -n "$LINK" ]; then
  echo
  echo "  Lien pour devenir admin (1 h, usage unique) — ouvre-le sur TON téléphone :"
  echo
  echo "  $LINK"
  echo
  echo "  Ne le copie nulle part ailleurs. Expiré ? Relance simplement ce script."
elif [ "$HAS_ADMIN" -eq 1 ]; then
  echo "  (Un admin existe déjà : pas de nouveau lien d'invitation.)"
else
  echo "  (Lien admin non généré : voir DEPLOIEMENT.md, « Le lien ne s'est pas affiché ».)"
fi
echo
echo "  Mettre à jour plus tard :   bash $APP_DIR/deploy/update.sh"
echo "  Voir les journaux :         journalctl -u terrain -f"
echo "  Sauvegardes (14 jours) :    $BACKUP_DIR"
echo "────────────────────────────────────────────────────────────────────────"
