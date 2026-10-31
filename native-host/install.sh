#!/usr/bin/env bash
# Registers the native messaging host for Firefox and Chromium-based browsers
# on Linux and macOS. Usage: ./install.sh [chromium-extension-id]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$DIR/host.py"
NAME="stream_player_host"
EXT_ID="${1:-}"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
chmod +x "$HOST"

if [ "$(uname)" = "Darwin" ]; then
  FIREFOX_DIRS=("$HOME/Library/Application Support/Mozilla/NativeMessagingHosts")
  CHROMIUM_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  )
else
  FIREFOX_DIRS=("$HOME/.mozilla/native-messaging-hosts")
  CHROMIUM_DIRS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
  )
fi

# json.dumps keeps paths with spaces/quotes valid
write_manifest() { # $1 = file, $2 = key, $3 = value
  python3 - "$1" "$HOST" "$NAME" "$2" "$3" <<'PY'
import json, sys
out, host, name, key, value = sys.argv[1:6]
manifest = {"name": name, "description": "Stream to Android Player Native Host",
            "path": host, "type": "stdio", key: [value]}
with open(out, "w") as f:
    json.dump(manifest, f, indent=2)
PY
}

for d in "${FIREFOX_DIRS[@]}"; do
  mkdir -p "$d"
  write_manifest "$d/$NAME.json" allowed_extensions "faisalbhuiyan@mozilla"
  echo "Firefox manifest: $d/$NAME.json"
done

if [ -n "$EXT_ID" ]; then
  for d in "${CHROMIUM_DIRS[@]}"; do
    mkdir -p "$d"
    write_manifest "$d/$NAME.json" allowed_origins "chrome-extension://$EXT_ID/"
    echo "Chromium manifest: $d/$NAME.json"
  done
else
  echo "No extension ID given: skipped Chrome/Edge/Brave/Chromium (re-run with the ID to add them)."
fi

echo "Done. Restart your browser."
