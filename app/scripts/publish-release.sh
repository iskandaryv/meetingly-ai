#!/usr/bin/env bash
# Build the Windows installers and publish them, with the macOS and Linux builds from GitHub Actions,
# to https://meetinglyai.com/download/.
#   bash scripts/publish-release.sh            # host defaults to "voyra"
# Publishes versioned files plus stable names the website links to, and latest*.yml for
# electron-updater (the app's publish provider is "generic" on that URL).
# macOS and Linux come from the latest successful "Desktop builds" run for this version
# (run it first: gh workflow run desktop-builds.yml); without one, only Windows is published.
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

# macOS and Linux, built on GitHub Actions.
REPO=$(git config --get remote.origin.url | sed -E 's#.*github.com[:/](.+)\.git$#\1#; s#.*github.com[:/](.+)$#\1#')
RUN=$(gh run list -R "$REPO" --workflow desktop-builds.yml --status success --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
if [ -n "$RUN" ]; then
  ART=$(mktemp -d)
  gh run download "$RUN" -R "$REPO" -D "$ART"
  found=0
  for f in "$ART"/*/*"${VERSION}"* "$ART"/*/latest-mac.yml "$ART"/*/latest-linux.yml; do
    [ -f "$f" ] && cp "$f" "$STAGE/" && found=1
  done
  if [ "$found" = 1 ] && ls "$STAGE"/*"${VERSION}"*.dmg >/dev/null 2>&1; then
    # Stable names for the website's download buttons.
    cp "$STAGE/Meetingly-${VERSION}-arm64.dmg" "$STAGE/Meetingly-mac-arm64.dmg"
    cp "$STAGE/Meetingly-${VERSION}-x64.dmg" "$STAGE/Meetingly-mac-x64.dmg"
  fi
  if ls "$STAGE"/*"${VERSION}"*.AppImage >/dev/null 2>&1; then
    cp "$STAGE/Meetingly-${VERSION}-x86_64.AppImage" "$STAGE/Meetingly-linux.AppImage"
    cp "$STAGE/Meetingly-${VERSION}-amd64.deb" "$STAGE/Meetingly-linux.deb"
  fi
  grep -q "version: ${VERSION}" "$STAGE/latest-mac.yml" 2>/dev/null || echo "warning: the macOS build is not version ${VERSION}"
  rm -rf "$ART"
else
  echo "no successful Desktop builds run: publishing Windows only"
fi

tar czf - -C "$STAGE" . | ssh "$HOST" "mkdir -p /var/www/meetingly/download && tar xzf - -C /var/www/meetingly/download && chmod -R a+rX /var/www/meetingly/download"
rm -rf "$STAGE"
for f in Meetingly-Setup.exe Meetingly.exe latest.yml Meetingly-mac-arm64.dmg Meetingly-mac-x64.dmg latest-mac.yml Meetingly-linux.AppImage Meetingly-linux.deb latest-linux.yml; do
  printf "%-26s %s\n" "$f" "$(curl -sI "https://meetinglyai.com/download/$f" | grep -iE '^HTTP|^content-length' | tr -d '\r' | tr '\n' ' ')"
done
echo "published v${VERSION}"
