#!/usr/bin/env bash
# Registers vlc:// (and optionally mpv://) for the current user on Linux.
# Usage: ./register-linux.sh [vlc] [mpv]      (default: vlc)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HANDLER="$DIR/handler.py"
APPS="$HOME/.local/share/applications"
chmod +x "$HANDLER"
mkdir -p "$APPS"

SCHEMES=("$@")
[ ${#SCHEMES[@]} -eq 0 ] && SCHEMES=(vlc)

for scheme in "${SCHEMES[@]}"; do
  cat > "$APPS/stream-player-$scheme.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Stream Player ($scheme link)
Exec=python3 "$HANDLER" %u
NoDisplay=true
MimeType=x-scheme-handler/$scheme;
EOF
  xdg-mime default "stream-player-$scheme.desktop" "x-scheme-handler/$scheme"
  echo "Registered $scheme://"
done
update-desktop-database "$APPS" 2>/dev/null || true
echo "Done. Handler: $HANDLER"
