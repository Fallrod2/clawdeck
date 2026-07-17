#!/bin/bash
# Installe (ou met à jour) le LaunchDaemon clawdeck de façon reproductible.
# Vérifie les prérequis AVANT de toucher au système ; à lancer avec sudo.
# Rollback : sudo launchctl bootout system/com.clawdeck.server
#            puis restaurer l'ancien plist et re-bootstrap.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO/launchd/com.clawdeck.server.plist"
PLIST_DST="/Library/LaunchDaemons/com.clawdeck.server.plist"
LABEL="com.clawdeck.server"
LOG_DIR="/Users/claw/Library/Logs/clawdeck"

fail() { echo "ERREUR : $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "à lancer avec sudo (installe un LaunchDaemon système)."
[ -f "$REPO/.env" ] || fail "$REPO/.env absent — copier .env.example et le remplir d'abord."
[ -f "$REPO/web/dist/index.html" ] || fail "web/dist absent — lancer 'bun run build' d'abord."
plutil -lint "$PLIST_SRC" > /dev/null || fail "plist invalide : $PLIST_SRC"

# La validation d'environnement du backend doit passer AVANT d'installer :
# un daemon qui crash-loop au boot est pire qu'une installation refusée.
if ! (cd "$REPO" && sudo -u claw /Users/claw/.bun/bin/bun -e '
  await import("./src/env.ts");
  console.log("env OK");
') ; then
  fail "la validation de .env a échoué — corriger avant d'installer (messages ci-dessus)."
fi

# Dossier de logs : launchd crée les fichiers mais jamais les dossiers.
mkdir -p "$LOG_DIR"
chown claw:staff "$LOG_DIR"

# Mise à jour idempotente : bootout silencieux si déjà chargé, puis bootstrap.
launchctl bootout "system/$LABEL" 2>/dev/null || true
cp "$PLIST_SRC" "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 644 "$PLIST_DST"
launchctl bootstrap system "$PLIST_DST"
launchctl print "system/$LABEL" | grep -E "state|pid" | head -3

echo "OK : $LABEL installé. Logs : $LOG_DIR/{stdout,stderr}.log"
