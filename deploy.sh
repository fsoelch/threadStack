#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Deploy-Script: Gesprächstermine → Server (SSH + systemd)
# Aufruf: ./deploy.sh <benutzer>
# Beispiel: ./deploy.sh flo
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/.deploy.env"

usage() {
  echo ""
  echo "Aufruf: ./deploy.sh <benutzer>"
  echo ""
  echo "  benutzer   SSH-Benutzername auf dem Server"
  echo ""
  echo "Beispiel: ./deploy.sh flo"
  echo ""
  echo "Alle weiteren Einstellungen (Host, Pfad, Port …) in .deploy.env"
  echo "Vorlage: cp .deploy.env.example .deploy.env"
  echo ""
  exit 1
}

# ── Parameter einlesen ───────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "❌  Benutzername fehlt."
  usage
fi

DEPLOY_USER="$1"

# ── Konfiguration laden ──────────────────────────────────────
if [[ ! -f "$CONFIG" ]]; then
  echo ""
  echo "❌  Keine Deploy-Konfiguration gefunden."
  echo ""
  echo "    Bitte einmalig einrichten:"
  echo "    cp .deploy.env.example .deploy.env"
  echo "    nano .deploy.env"
  echo ""
  exit 1
fi

source "$CONFIG"

: "${DEPLOY_HOST:?Fehlt in .deploy.env: DEPLOY_HOST}"
: "${DEPLOY_PATH:?Fehlt in .deploy.env: DEPLOY_PATH}"

# Defaults für optionale Felder
DEPLOY_PORT="${DEPLOY_PORT:-22}"
APP_PORT="${APP_PORT:-3000}"
BASE_PATH="${BASE_PATH:-/notes}"
SERVICE_NAME="${SERVICE_NAME:-gespraeche}"

# ── SSH-Hilfsfunktionen ──────────────────────────────────────
SSH_OPTS="-p $DEPLOY_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

ssh_run() {
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "$DEPLOY_USER@$DEPLOY_HOST" "$@"
}

rsync_upload() {
  # shellcheck disable=SC2086
  rsync -avz --delete \
    -e "ssh $SSH_OPTS" \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='data/' \
    --exclude='.deploy.env' \
    --exclude='.deploy.env.example' \
    --exclude='deploy.sh' \
    --exclude='*.log' \
    --exclude='.DS_Store' \
    --exclude='.claude/' \
    --exclude='ThreadStackApp/' \
    --exclude='test/' \
    --exclude='*.docx' \
    --exclude='/tmp' \
    "$SCRIPT_DIR/" \
    "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/"
}

# ── Verbindungstest ───────────────────────────────────────────
step() { echo ""; echo "▶  $*"; }
ok()   { echo "   ✓  $*"; }
warn() { echo "   ⚠  $*"; }

echo ""
echo "┌────────────────────────────────────────────────────────┐"
echo "│  Deploy: Gesprächstermine                              │"
printf "│  Server: %-45s │\n" "$DEPLOY_USER@$DEPLOY_HOST"
printf "│  Pfad  : %-45s │\n" "$DEPLOY_PATH"
printf "│  URL   : %-45s │\n" "http://$DEPLOY_HOST:$APP_PORT$BASE_PATH"
echo "└────────────────────────────────────────────────────────┘"

step "Verbindung testen …"
if ! ssh_run "echo ok" &>/dev/null; then
  echo ""
  echo "❌  SSH-Verbindung fehlgeschlagen."
  echo "    Prüfen Sie Host, Port und SSH-Key in .deploy.env"
  exit 1
fi
ok "SSH-Verbindung steht"

# ── Schritt 1: Dateien hochladen ─────────────────────────────
step "Dateien hochladen …"
ssh_run "mkdir -p '$DEPLOY_PATH'"
rsync_upload
ok "Dateien hochgeladen"

# ── Schritt 2: npm install auf dem Server ────────────────────
step "Abhängigkeiten installieren (npm install --omit=dev) …"
ssh_run "source ~/.nvm/nvm.sh 2>/dev/null; cd '$DEPLOY_PATH' && npm install --omit=dev --silent"
ok "Abhängigkeiten installiert"

# ── Schritt 3: Systemd-Service neustarten ────────────────────
step "Service neustarten …"
ssh_run "sudo systemctl restart '$SERVICE_NAME'"
sleep 2

STATUS="$(ssh_run "systemctl is-active '$SERVICE_NAME'" 2>/dev/null || echo 'unknown')"

if [[ "$STATUS" == "active" ]]; then
  ok "Service läuft"
else
  warn "Service-Status: ${STATUS:-unbekannt}"
  echo ""
  echo "    Logs prüfen:"
  echo "    ssh $DEPLOY_USER@$DEPLOY_HOST 'journalctl -u $SERVICE_NAME -n 30'"
  echo ""
  exit 1
fi

# ── Fertig ────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Deploy erfolgreich!"
echo ""
echo "   App-URL  : http://$DEPLOY_HOST:$APP_PORT$BASE_PATH"
echo "   Logs     : ssh $DEPLOY_USER@$DEPLOY_HOST 'journalctl -u $SERVICE_NAME -f'"
echo "   Status   : ssh $DEPLOY_USER@$DEPLOY_HOST 'systemctl status $SERVICE_NAME'"
echo "   Neustart : ssh $DEPLOY_USER@$DEPLOY_HOST 'sudo systemctl restart $SERVICE_NAME'"
echo ""
if [[ "$APP_PORT" != "80" && "$APP_PORT" != "443" ]]; then
  echo "   💡 Reverse-Proxy (nginx) für Port 80/443:"
  echo ""
  echo "      location $BASE_PATH {"
  echo "          proxy_pass http://127.0.0.1:$APP_PORT;"
  echo "          proxy_set_header Host \$host;"
  echo "          proxy_set_header X-Real-IP \$remote_addr;"
  echo "      }"
  echo ""
fi
