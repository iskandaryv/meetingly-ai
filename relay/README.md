# Meetingly relay

The small Node service behind Meetingly's free and Pro plans. It holds the AI provider key and the Deepgram key,
picks the model for each task and counts usage per account, so the desktop app ships with no provider keys and
users configure nothing.

You don't need it to run Meetingly yourself: with **your own API key** (in the panel: *Use your own API key*) the
app talks straight to OpenAI, OpenRouter, Ollama or any OpenAI-compatible endpoint, and this relay is never called.

```
GET  /health                     -> { ok, version, models, plans, guestUntil }
GET  /v1/usage                   today's usage and limits for the calling account
POST /v1/chat/completions        OpenAI-compatible; Authorization: Bearer <APP_TOKEN>, X-Device-Id: <id>
GET  /v1/listen (WebSocket)      Deepgram live passthrough; same auth via headers or ?token=&device=
```

The public instance is `https://aiprimetech.io/igpt` (nginx strips the `/igpt/` prefix).

**Accounts and plans.** Every request from app 1.1.0 on carries the user's account token (`X-Meetingly-Account`);
the relay asks the account service (`GET /api/meetingly/entitlement`, cached 5 min) for the user and plan, and
counts per account per UTC day. Budgets are in `plans.mjs`:

| | Guest (1.0.0, per IP, until 2026-11-04) | Free | Pro |
|---|---|---|---|
| answers (`answer`, real answers of `auto`) | 20 | 100 | 1,500 |
| screen analysis (`vision`) | 3 | 10 | 200 |
| listening (`suggest`, `auto` checks that answer nothing) | 60 | 300 | 3,000 |
| meeting reports (`report`) | 2 | 5 | 50 |
| tokens (ceiling over everything) | 60k | 300k | 4M |
| requests at once | 1 | 2 | 3 |
| Deepgram minutes | 30 | 60 | 600 |

Plus 600 free answers per IP per day across accounts, `CHAT_PER_DAY` requests per account, 60 requests/min per IP.
Limits answer 429 with `{error: {code, message, resetAt}}` and `x-should-retry: false`.

**Models are chosen here, never by the app.** The app sends `X-Meetingly-Task: answer | suggest | vision | report`;
`DEFAULT_MODEL` serves every task, `MODEL_<TASK>` overrides one, `FALLBACK_MODEL` is tried when the first choice
fails before sending anything. Responses carry `X-Meetingly-Model` with the model that served them. Switching
models needs a restart, not an app release.

## Running it

```bash
cd relay
npm ci
cp relay.env.example .env    # fill UPSTREAM_BASE_URL, UPSTREAM_API_KEY, DEEPGRAM_API_KEY, APP_TOKEN
set -a; . ./.env; set +a
node relay.mjs               # http://127.0.0.1:8090/health
npm test
```

Point a development build at it with `IGPT_RELAY_URL=http://127.0.0.1:8090` (the app token must match
`app/shared/relay.ts`). In production it runs as a systemd service (`meetingly-relay.service`) behind nginx
(`nginx-location.conf`, `nginx-upgrade-map.conf`); `deploy.sh <ssh-host>` copies and restarts it.
