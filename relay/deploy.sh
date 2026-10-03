#!/usr/bin/env bash
# Deploy or update the relay on Voyra:
#   bash relay/deploy.sh             # host defaults to "voyra"
# First run also needs /etc/meetingly-relay.env and the nginx location (relay/README.md).
# Uses tar over ssh so it works from Git Bash on Windows (no rsync needed).
set -euo pipefail
HOST="${1:-voyra}"
NAME=meetingly-relay
DEST=/opt/$NAME

ssh "$HOST" "id meetingly >/dev/null 2>&1 || useradd --system --home $DEST --shell /sbin/nologin meetingly
mkdir -p $DEST /var/lib/$NAME && chown meetingly:meetingly /var/lib/$NAME"

tar czf - -C "$(dirname "$0")" --exclude node_modules --exclude usage.json --exclude '*.test.mjs' . | ssh "$HOST" "tar xzf - -C $DEST"

ssh "$HOST" "set -e
cd $DEST && npm ci --omit=dev --no-audit --no-fund && chown -R meetingly:meetingly $DEST
install -m 644 $DEST/$NAME.service /etc/systemd/system/$NAME.service
systemctl daemon-reload && systemctl enable $NAME >/dev/null && systemctl restart $NAME
sleep 1 && systemctl is-active $NAME && curl -fsS http://127.0.0.1:8090/health && echo"
echo "deployed to $HOST"
