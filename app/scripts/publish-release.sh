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
# Always package what is in the repo now, never an older dist/.
npm run build >/dev/null
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

# macOS and Linux, built on GitHub Actions. The box downloads them itself (much faster than this PC);
# the GitHub token goes over stdin, never onto a command line.
REPO=$(git config --get remote.origin.url | sed -E 's#.*github.com[:/](.+)\.git$#\1#; s#.*github.com[:/](.+)$#\1#')
RUN=$(gh run list -R "$REPO" --workflow desktop-builds.yml --status success --limit 1 --json databaseId --jq ".[0].databaseId" 2>/dev/null || true)
IDS=""
[ -n "$RUN" ] && IDS=$(gh api "repos/$REPO/actions/runs/$RUN/artifacts" --jq '.artifacts[] | "\(.name)=\(.id)"' | tr '\n' ' ')

tar czf - -C "$STAGE" . | ssh "$HOST" "mkdir -p /var/www/meetingly/download && tar xzf - -C /var/www/meetingly/download && chmod -R a+rX /var/www/meetingly/download"
rm -rf "$STAGE"

if [ -n "$IDS" ]; then
  gh auth token | ssh "$HOST" "read T; set -e; D=/tmp/meetingly-ci-$VERSION; rm -rf \$D; mkdir -p \$D; cd \$D
    for p in $IDS; do n=\${p%%=*}; i=\${p#*=}
      curl -fsSL -H \"Authorization: Bearer \$T\" -o \$n.zip https://api.github.com/repos/$REPO/actions/artifacts/\$i/zip
      mkdir -p \$n && (cd \$n && python3 -m zipfile -e ../\$n.zip .) && rm \$n.zip
    done
    grep -q 'version: $VERSION' */latest-mac.yml || { echo 'the macOS/Linux builds are not version $VERSION: run Desktop builds first'; exit 1; }
    W=/var/www/meetingly/download
    cp */*$VERSION* */latest-mac.yml */latest-linux.yml \$W/
    cp \$W/Meetingly-$VERSION-arm64.dmg \$W/Meetingly-mac-arm64.dmg
    cp \$W/Meetingly-$VERSION-x64.dmg \$W/Meetingly-mac-x64.dmg
    cp \$W/Meetingly-$VERSION-x86_64.AppImage \$W/Meetingly-linux.AppImage
    cp \$W/Meetingly-$VERSION-amd64.deb \$W/Meetingly-linux.deb
    chmod -R a+rX \$W; rm -rf \$D"
else
  echo "no successful Desktop builds run: published Windows only"
fi
for f in Meetingly-Setup.exe Meetingly.exe latest.yml Meetingly-mac-arm64.dmg Meetingly-mac-x64.dmg latest-mac.yml Meetingly-linux.AppImage Meetingly-linux.deb latest-linux.yml; do
  printf "%-26s %s\n" "$f" "$(curl -sI "https://meetinglyai.com/download/$f" | grep -iE '^HTTP|^content-length' | tr -d '\r' | tr '\n' ' ')"
done
echo "published v${VERSION}"
