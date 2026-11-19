#!/usr/bin/env bash
# Installation de Terrain sur un VPS neuf (Ubuntu 24.04 ou Debian 12).
#
#   bash install.sh carte.raphaelgosset.fr
#
# Relançable sans risque : il met à jour ce qui existe déjà.
set -euo pipefail

DOMAIN="${1:-}"
GITHUB_REPO="${GITHUB_REPO:-Raphv2/lfiMap}"
APP_DIR=/opt/terrain
DATA_DIR=/var/lib/terrain
BACKUP_DIR=/var/backups/terrain
APP_USER=terrain

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }
# Exécute une commande en tant qu'utilisateur de l'app (sa clé SSH est dans $DATA_DIR/.ssh).
as_app() { runuser -u "$APP_USER" -- env HOME="$DATA_DIR" "$@"; }

[ -n "$DOMAIN" ] || die "indique le domaine. Exemple : bash install.sh carte.raphaelgosset.fr"
[ "$(id -u)" -eq 0 ] || die "lance ce script en root (ou avec sudo)."
command -v apt-get >/dev/null || die "ce script est prévu pour Ubuntu ou Debian."

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

say "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https

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

say "Caddy (serveur web + HTTPS automatique)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

say "Utilisateur système et dossiers"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR" "$BACKUP_DIR"

say "Code de l'application"
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" pull --ff-only
else
  if GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$GITHUB_REPO.git" >/dev/null 2>&1; then
    REPO_URL="https://github.com/$GITHUB_REPO.git"   # dépôt public
  else
    # Dépôt privé : clé de déploiement en lecture seule, propre à ce serveur.
    REPO_URL="git@github.com:$GITHUB_REPO.git"
    KEY="$DATA_DIR/.ssh/id_ed25519"
    if [ ! -f "$KEY" ]; then
      install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR/.ssh"
      as_app ssh-keygen -q -t ed25519 -N '' -C "terrain@$DOMAIN" -f "$KEY"
    fi
    as_app bash -c "ssh-keyscan -t ed25519 github.com 2>/dev/null >> '$DATA_DIR/.ssh/known_hosts'; sort -u -o '$DATA_DIR/.ssh/known_hosts' '$DATA_DIR/.ssh/known_hosts'"
    until as_app git ls-remote "$REPO_URL" >/dev/null 2>&1; do
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
  install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_DIR"
  as_app git clone --quiet "$REPO_URL" "$APP_DIR"
fi

say "Dépendances et compilation de l'interface"
as_app npm_config_cache=/tmp/terrain-npm \
  bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent"

say "Services (démarrage automatique, sauvegarde quotidienne)"
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/terrain.service" > /etc/systemd/system/terrain.service
cp "$APP_DIR/deploy/terrain-backup.service" "$APP_DIR/deploy/terrain-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet terrain.service terrain-backup.timer
systemctl restart terrain.service
systemctl start terrain-backup.timer

say "Caddy → https://$DOMAIN"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "Terrain" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.avant-terrain"
fi
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

say "Pare-feu et mises à jour de sécurité automatiques"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

say "Vérification"
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:3180/ && break
  sleep 1
done
systemctl is-active --quiet terrain || die "l'application ne démarre pas. Regarde : journalctl -u terrain -n 50"
echo "  Application : en marche"

LINK="$(journalctl -u terrain --no-pager -n 200 -o cat | grep -o "https://$DOMAIN/#/join/[A-Za-z0-9_-]*" | tail -n 1 || true)"
echo
echo "────────────────────────────────────────────────────────────────────────"
echo "  Terrain est installé : https://$DOMAIN"
if [ -n "$LINK" ]; then
  echo
  echo "  Lien pour devenir admin (24 h, usage unique) — ouvre-le sur TON téléphone :"
  echo
  echo "  $LINK"
else
  echo "  (Un admin existe déjà : pas de nouveau lien d'invitation.)"
fi
echo
echo "  Mettre à jour plus tard :   bash $APP_DIR/deploy/update.sh"
echo "  Voir les journaux :         journalctl -u terrain -f"
echo "  Sauvegardes (14 jours) :    $BACKUP_DIR"
echo "────────────────────────────────────────────────────────────────────────"
