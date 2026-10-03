#!/usr/bin/env bash
# Build the Windows installers and publish them to https://meetinglyai.com/download/.
#   bash scripts/publish-release.sh            # host defaults to "voyra"
# Publishes versioned files plus stable names the website links to, and latest.yml
# for electron-updater (the app's publish provider is "generic" on that URL).
set -euo pipefail
HOST="${1:-voyra}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
npx electron-builder --win --publish never >/dev/null
SETUP="release/Meetingly Setup ${VERSION}.exe"
PORTABLE="release/Meetingly ${VERSION}.exe"
[ -f "$SETUP" ] && [ -f "$PORTABLE" ] || { echo "installers missing in release/"; ls release; exit 1; }

STAGE=$(mktemp -d)
cp "$SETUP" "$STAGE/Meetingly-Setup-${VERSION}.exe"
cp "$PORTABLE" "$STAGE/Meetingly-${VERSION}.exe"
cp "$SETUP" "$STAGE/Meetingly-Setup.exe"
cp "$PORTABLE" "$STAGE/Meetingly.exe"
cp "release/latest.yml" "$STAGE/latest.yml"
cp "${SETUP}.blockmap" "$STAGE/Meetingly-Setup-${VERSION}.exe.blockmap" 2>/dev/null || true
# latest.yml references the versioned file name used by electron-builder; align it with what we uploaded.
sed -i "s|Meetingly Setup ${VERSION}.exe|Meetingly-Setup-${VERSION}.exe|g" "$STAGE/latest.yml"

tar czf - -C "$STAGE" . | ssh "$HOST" "mkdir -p /var/www/meetingly/download && tar xzf - -C /var/www/meetingly/download && chmod -R a+rX /var/www/meetingly/download"
rm -rf "$STAGE"
for f in Meetingly-Setup.exe Meetingly.exe latest.yml; do
  printf "%-22s %s\n" "$f" "$(curl -sI "https://meetinglyai.com/download/$f" | grep -iE '^HTTP|^content-length' | tr -d '\r' | tr '\n' ' ')"
done
echo "published v${VERSION}"
