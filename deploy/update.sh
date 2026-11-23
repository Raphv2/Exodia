#!/usr/bin/env bash
# Met Terrain à jour avec la dernière version poussée sur GitHub.
#   bash /opt/terrain/deploy/update.sh
# Mode strict : -e arrête le script à la première erreur ; -u signale toute variable non
# définie ; -o pipefail fait échouer un enchaînement « a | b » si l'une des commandes échoue.
set -euo pipefail

# Dossier du code et compte système de l'app (mêmes valeurs que install.sh).
APP_DIR=/opt/terrain
APP_USER=terrain
# Refuse de continuer sans droits root (id -u vaut 0 pour root).
[ "$(id -u)" -eq 0 ] || { echo "Lance ce script en root (ou avec sudo)." >&2; exit 1; }

# 1) Sauvegarde avant de toucher à quoi que ce soit (systemctl attend la fin : service oneshot).
echo "==> Sauvegarde avant mise à jour"
systemctl start terrain-backup.service

# 2) Récupère le nouveau code. runuser -u terrain : la commande tourne sous le compte de l'app,
# propriétaire du dépôt ; HOME pointe vers ses données, où se trouve sa clé SSH GitHub.
# --ff-only : refuse si l'historique local a divergé (pas de fusion imprévue).
echo "==> Récupération du code"
runuser -u "$APP_USER" -- env HOME=/var/lib/terrain git -C "$APP_DIR" pull --ff-only

# 3) Réinstalle les dépendances exactes et recompile l'interface (cache npm dans /tmp).
echo "==> Dépendances et compilation"
runuser -u "$APP_USER" -- env HOME=/var/lib/terrain npm_config_cache=/tmp/terrain-npm \
  bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent"

# Les fichiers de service ont pu changer : on les réinstalle.
# Relit le domaine dans le service déjà installé (ligne PUBLIC_URL), puis régénère ce
# service à partir de la version du dépôt en y remettant ce domaine.
DOMAIN="$(sed -n 's#^Environment=PUBLIC_URL=https://##p' /etc/systemd/system/terrain.service)"
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/terrain.service" > /etc/systemd/system/terrain.service
# Recopie les fichiers de la sauvegarde ; daemon-reload fait relire ses fichiers à systemd.
cp "$APP_DIR/deploy/terrain-backup.service" "$APP_DIR/deploy/terrain-backup.timer" /etc/systemd/system/
systemctl daemon-reload

# 4) Redémarre l'app, attend 2 secondes et vérifie qu'elle tourne : affiche le commit
# déployé, ou les 30 dernières lignes du journal en cas d'échec (et sort avec le code 1).
echo "==> Redémarrage"
systemctl restart terrain
sleep 2
if systemctl is-active --quiet terrain; then
  echo "OK : $(runuser -u "$APP_USER" -- git -C "$APP_DIR" log --oneline -1)"
else
  journalctl -u terrain -n 30 --no-pager
  exit 1
fi
