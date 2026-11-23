#!/usr/bin/env bash
# Met Terrain à jour avec la dernière version poussée sur GitHub.
#   bash /opt/terrain/deploy/update.sh
#
# En cas d'échec (installation des dépendances, compilation, ou app qui ne répond plus après
# redémarrage), le script revient TOUT SEUL à la version précédente du code et la relance.
#
# Mode strict : -e arrête le script à la première erreur ; -u signale toute variable non
# définie ; -o pipefail fait échouer un enchaînement « a | b » si l'une des commandes échoue.
set -euo pipefail

# Dossier du code, comptes système (mêmes valeurs que install.sh) : terrain-deploy possède le
# code et le compile ; terrain fait tourner l'app.
APP_DIR=/opt/terrain
DEPLOY_USER=terrain-deploy
DEPLOY_HOME=/var/lib/terrain-deploy
HEALTH_URL=http://127.0.0.1:3180/api/health

say() { printf '==> %s\n' "$*"; }
die() { printf '\nErreur : %s\n' "$*" >&2; exit 1; }
# Commande sous le compte qui possède le code (HOME : sa clé SSH GitHub et son cache npm).
as_deploy() { runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" "$@"; }

# Dépendances exactes + compilation de l'interface. umask 022 : fichiers lisibles par le compte
# de l'app, modifiables par le seul compte de déploiement.
build() {
  as_deploy bash -c "umask 022 && cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent"
}

# Les fichiers de service ont pu changer : on les réinstalle depuis le dépôt, en y remettant
# le domaine ; daemon-reload fait relire ses fichiers à systemd.
install_units() {
  sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/terrain.service" > /etc/systemd/system/terrain.service
  cp "$APP_DIR/deploy/terrain-backup.service" "$APP_DIR/deploy/terrain-backup.timer" /etc/systemd/system/
  systemctl daemon-reload
}

# Redémarre l'app puis attend (jusqu'à 30 s) qu'elle réponde 200 sur /api/health (l'app tourne
# ET sa base répond) ; vérifie aussi que systemd la voit active. Code de retour 0 si tout va bien.
restart_and_check() {
  systemctl restart terrain
  for _ in $(seq 1 30); do
    sleep 1
    if curl -fsS -o /dev/null "$HEALTH_URL" && systemctl is-active --quiet terrain; then return 0; fi
  done
  return 1
}

# Retour arrière : code remis au commit d'avant la mise à jour, dépendances et interface
# reconstruites, services réinstallés, app relancée. Puis arrêt du script en erreur.
rollback() {
  local why="$1"
  echo
  echo "!!! $why"
  echo "!!! Retour automatique à la version précédente ($PREV)…"
  as_deploy git -C "$APP_DIR" reset --hard --quiet "$PREV"
  if build; then
    install_units
    if restart_and_check; then
      die "mise à jour annulée, l'app tourne de nouveau sur l'ancienne version ($(as_deploy git -C "$APP_DIR" log --oneline -1)). Rien n'est perdu ; corrige le problème puis relance ce script."
    fi
  fi
  journalctl -u terrain -n 30 --no-pager || true
  die "le retour arrière n'a pas suffi : l'app ne répond pas. Regarde : journalctl -u terrain -n 50
La sauvegarde faite juste avant la mise à jour est la plus récente de /var/backups/terrain (voir DEPLOIEMENT.md, « Restaurer »)."
}

# Tout le travail est dans main, lue EN ENTIER par bash avant de commencer : le script peut donc
# se modifier lui-même (git pull, retour arrière) sans que bash ne lise un morceau de la nouvelle version.
main() {
  # Refuse de continuer sans droits root (id -u vaut 0 pour root).
  [ "$(id -u)" -eq 0 ] || die "lance ce script en root (ou avec sudo)."
  # Ancienne installation (code appartenant au compte de l'app) : install.sh fait la migration.
  id "$DEPLOY_USER" >/dev/null 2>&1 \
    || die "installation ancienne : relance d'abord bash $APP_DIR/deploy/install.sh <domaine> (il migre vers le compte $DEPLOY_USER)."

  # Domaine : relu dans le service déjà installé (ligne PUBLIC_URL). Vide = service absent ou
  # abîmé : on s'arrête AVANT de toucher à quoi que ce soit, sinon le service serait réécrit
  # avec une adresse vide.
  DOMAIN="$(sed -n 's#^Environment=PUBLIC_URL=https://##p' /etc/systemd/system/terrain.service 2>/dev/null || true)"
  [[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,63}$ ]] \
    || die "domaine introuvable dans /etc/systemd/system/terrain.service (ligne PUBLIC_URL). Relance install.sh <domaine>."

  # 1) Sauvegarde avant de toucher à quoi que ce soit (systemctl attend la fin : service oneshot).
  say "Sauvegarde avant mise à jour"
  systemctl start terrain-backup.service

  # 2) Récupère le nouveau code, en notant d'abord le commit actuel (pour un éventuel retour
  # arrière). --ff-only : refuse si l'historique local a divergé (pas de fusion imprévue).
  say "Récupération du code"
  PREV="$(as_deploy git -C "$APP_DIR" rev-parse HEAD)"
  as_deploy git -C "$APP_DIR" pull --ff-only
  echo "    $(as_deploy git -C "$APP_DIR" log --oneline -1)"

  # 3) Réinstalle les dépendances exactes et recompile l'interface ; retour arrière si échec.
  say "Dépendances et compilation"
  build || rollback "échec de l'installation des dépendances ou de la compilation."

  # 4) Services, redémarrage et contrôle par HTTP ; retour arrière si l'app ne répond pas.
  say "Redémarrage"
  install_units
  if ! restart_and_check; then
    journalctl -u terrain -n 30 --no-pager || true
    rollback "l'app ne répond pas sur $HEALTH_URL après la mise à jour."
  fi
  echo "OK : $(as_deploy git -C "$APP_DIR" log --oneline -1)"
}

main "$@"
exit
