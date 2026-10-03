#!/usr/bin/env bash
# Deploy or update the relay on Voyra. Run from the repo root on the dev machine:
#   bash relay/deploy.sh             # host defaults to "voyra"
# First run also needs /etc/igpt-relay.env and the nginx location (relay/README.md).
# Uses tar over ssh so it works from Git Bash on Windows (no rsync needed).
set -euo pipefail
HOST="${1:-voyra}"
DEST=/opt/igpt-relay

ssh "$HOST" 'id igpt >/dev/null 2>&1 || useradd --system --home /opt/igpt-relay --shell /sbin/nologin igpt
mkdir -p /opt/igpt-relay /var/lib/igpt-relay && chown igpt:igpt /var/lib/igpt-relay'

tar czf - -C "$(dirname "$0")" --exclude node_modules --exclude usage.json --exclude '*.test.mjs' . | ssh "$HOST" "tar xzf - -C $DEST"

ssh "$HOST" "set -e
cd $DEST && npm ci --omit=dev --no-audit --no-fund && chown -R igpt:igpt $DEST
install -m 644 $DEST/igpt-relay.service /etc/systemd/system/igpt-relay.service
systemctl daemon-reload && systemctl enable igpt-relay >/dev/null && systemctl restart igpt-relay
sleep 1 && systemctl is-active igpt-relay && curl -fsS http://127.0.0.1:8090/health && echo"
echo "deployed to $HOST"
