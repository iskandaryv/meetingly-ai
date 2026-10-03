# Meetingly relay

Small Node service that owns the LLM gateway key (claudeshop.store) and the Deepgram key. The desktop app ships with only the relay URL and an app token, so end users configure nothing.

Runs on **Voyra** (US East, `ssh voyra`) as `igpt-relay.service` on `127.0.0.1:8090`, behind the existing nginx. Public base URL: **`https://aiprimetech.io/igpt`**. nginx strips the `/igpt/` prefix, so no extra DNS record or certificate is needed.

```
GET  /igpt/health                     -> { ok, version, models: { default, fallback, perTask } }
POST /igpt/v1/chat/completions        OpenAI-compatible; Authorization: Bearer <APP_TOKEN>, X-Device-Id: <id>
GET  /igpt/v1/listen (WebSocket)      Deepgram live passthrough; same auth via headers or ?token=&device=
```

Limits per device per day: 2000 chat requests, 300 minutes of audio; 60 requests/min per IP.

**Models are chosen here, never by the app.** The app sends `X-Meetingly-Task: answer | suggest | vision | report`; `DEFAULT_MODEL` serves every task, `MODEL_<TASK>` overrides one, `FALLBACK_MODEL` is tried when the first choice fails before sending anything. Responses carry `X-Meetingly-Model` with the model that served them. To switch models, edit `/etc/igpt-relay.env` and `systemctl restart igpt-relay`; no app release needed.

## First-time setup

```bash
# 1. Secrets
scp relay/relay.env.example voyra:/etc/igpt-relay.env
ssh voyra 'chmod 600 /etc/igpt-relay.env && vi /etc/igpt-relay.env'    # fill the three keys

# 2. Service
bash relay/deploy.sh

# 3. nginx: upgrade map + location block inside the 443 server of aiprimetech.conf
scp relay/nginx-upgrade-map.conf voyra:/etc/nginx/conf.d/00-connection-upgrade-map.conf
#    paste relay/nginx-igpt-location.conf into the ssl server block, then:
ssh voyra 'if nginx -t >/tmp/nginx-t 2>&1; then systemctl reload nginx; else cat /tmp/nginx-t; fi'
curl https://aiprimetech.io/igpt/health
```

## Operating

```bash
ssh voyra systemctl status igpt-relay
ssh voyra journalctl -u igpt-relay -f
curl https://aiprimetech.io/igpt/health
bash relay/deploy.sh            # redeploy after code changes
```

Point it at another OpenAI-compatible provider with `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`. Rotate keys by editing `/etc/igpt-relay.env` and `systemctl restart igpt-relay`. Rotating `APP_TOKEN` also requires a new app build (`shared/relay.ts`).
