#!/usr/bin/env bash
# Met Terrain à jour avec la dernière version poussée sur GitHub.
#   bash /opt/terrain/deploy/update.sh
set -euo pipefail

APP_DIR=/opt/terrain
APP_USER=terrain
[ "$(id -u)" -eq 0 ] || { echo "Lance ce script en root (ou avec sudo)." >&2; exit 1; }

echo "==> Sauvegarde avant mise à jour"
systemctl start terrain-backup.service

echo "==> Récupération du code"
runuser -u "$APP_USER" -- git -C "$APP_DIR" pull --ff-only

echo "==> Dépendances et compilation"
runuser -u "$APP_USER" -- env HOME=/var/lib/terrain npm_config_cache=/tmp/terrain-npm \
  bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent"

# Les fichiers de service ont pu changer : on les réinstalle.
DOMAIN="$(sed -n 's#^Environment=PUBLIC_URL=https://##p' /etc/systemd/system/terrain.service)"
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/terrain.service" > /etc/systemd/system/terrain.service
cp "$APP_DIR/deploy/terrain-backup.service" "$APP_DIR/deploy/terrain-backup.timer" /etc/systemd/system/
systemctl daemon-reload

echo "==> Redémarrage"
systemctl restart terrain
sleep 2
if systemctl is-active --quiet terrain; then
  echo "OK : $(runuser -u "$APP_USER" -- git -C "$APP_DIR" log --oneline -1)"
else
  journalctl -u terrain -n 30 --no-pager
  exit 1
fi
