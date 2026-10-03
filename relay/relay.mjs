// Meetingly relay. The desktop app never sees provider keys; it talks to this
// service with a shared app token and a per-install device id. This process
// terminates TLS itself (no nginx: 80/443 on the box belong to other services).
//
// Endpoints
//   GET  /health                      liveness + version
//   POST /v1/chat/completions         OpenAI-compatible, streamed or not, forwarded to the upstream gateway
//   GET  /v1/listen  (WebSocket)      Deepgram live transcription, bidirectional passthrough
//
// Deployed on Voyra behind nginx at https://aiprimetech.io/igpt/ (nginx strips the prefix).
// Env (see relay.env.example): UPSTREAM_BASE_URL, UPSTREAM_API_KEY, DEEPGRAM_API_KEY, APP_TOKEN, HOST, PORT, TRUST_PROXY,
//   TLS_CERT/TLS_KEY (only without nginx in front), DEFAULT_MODEL, FALLBACK_MODEL, MODEL_<TASK>, quotas.

import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { WebSocket, WebSocketServer } from "ws"
import { ANSWER_TASKS, ReplyWatcher } from "./answers.mjs"
import { modelConfig, modelsFor } from "./models.mjs"
import { Quotas } from "./quotas.mjs"

const env = process.env
const PORT = Number(env.PORT ?? 8090)
const HOST = env.HOST ?? "127.0.0.1"
// Behind nginx the socket peer is always localhost; rate-limit on the forwarded client IP instead.
const TRUST_PROXY = env.TRUST_PROXY === "1"
const APP_TOKEN = required("APP_TOKEN")
// Any OpenAI-compatible chat/completions endpoint. Default: the claudeshop.store gateway.
const UPSTREAM_BASE_URL = (env.UPSTREAM_BASE_URL ?? "https://claudeshop.store/v1").replace(/\/+$/, "")
const UPSTREAM_API_KEY = (env.UPSTREAM_API_KEY ?? env.OPENROUTER_API_KEY ?? "").trim() || required("UPSTREAM_API_KEY")
const DEEPGRAM_API_KEY = required("DEEPGRAM_API_KEY")
const MODELS = modelConfig(env)
// Free answers per device per day. Hands-free checks that answer nothing, suggestions and reports do not count.
const ANSWERS_PER_DAY = Number(env.ANSWERS_PER_DAY ?? 100)
const MAX_TOKENS = Number(env.MAX_TOKENS ?? 4096)
// Reasoning models: how hard to think. "low" keeps a live assistant snappy. Empty = do not send.
const REASONING_EFFORT = (env.REASONING_EFFORT ?? "low").trim()
const MAX_BODY_BYTES = Number(env.MAX_BODY_BYTES ?? 6 * 1024 * 1024) // screenshots ride inside
const VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version

const quotas = new Quotas({
  file: env.USAGE_FILE ?? "/var/lib/meetingly-relay/usage.json",
  chatPerDay: Number(env.CHAT_PER_DAY ?? 400),
  answersPerDay: ANSWERS_PER_DAY,
  audioMinutesPerDay: Number(env.AUDIO_MINUTES_PER_DAY ?? 300),
  requestsPerMinutePerIp: Number(env.RPM_PER_IP ?? 60)
})

const ALLOWED_LISTEN_PARAMS = new Set([
  "language", "encoding", "sample_rate", "channels", "interim_results", "punctuate",
  "smart_format", "endpointing", "vad_events", "utterance_end_ms", "diarize"
])

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://relay")
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, version: VERSION, models: MODELS, limits: { answersPerDay: ANSWERS_PER_DAY, requestsPerDay: Number(env.CHAT_PER_DAY ?? 400) } })
    }
    const auth = authenticate(req, url)
    if (!auth.ok) return json(res, 401, { error: { message: auth.reason } })
    const ip = clientIp(req)
    if (!quotas.allowRequest(ip)) return json(res, 429, { error: { message: "Too many requests, slow down." } })

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await chatCompletions(req, res, auth.device)
    }
    json(res, 404, { error: { message: "Not found" } })
  } catch (err) {
    console.error(`[relay] ${req.method} ${url.pathname}:`, err.message)
    if (!res.headersSent) json(res, 500, { error: { message: "Relay error" } })
    else res.end()
  }
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://relay")
  if (url.pathname !== "/v1/listen") return rejectUpgrade(socket, 404, "Not found")
  const auth = authenticate(req, url)
  if (!auth.ok) return rejectUpgrade(socket, 401, auth.reason)
  if (!quotas.allowRequest(clientIp(req))) return rejectUpgrade(socket, 429, "Too many requests")
  if (!quotas.allowAudio(auth.device)) return rejectUpgrade(socket, 429, "Daily transcription limit reached")
  wss.handleUpgrade(req, socket, head, (client) => proxyListen(client, url, auth.device))
})

server.listen(PORT, HOST, () => {
  console.log(`[relay] v${VERSION} listening on ${HOST}:${PORT} (${server instanceof https.Server ? "https" : "http"}), models: ${JSON.stringify(MODELS)}`)
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    quotas.flush()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}

// ---------------------------------------------------------------------------

async function chatCompletions(req, res, device) {
  if (!quotas.allowChat(device)) {
    return json(res, 429, { error: { message: "Daily chat limit reached. Try again tomorrow." } })
  }
  const raw = await readBody(req, MAX_BODY_BYTES)
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return json(res, 400, { error: { message: "Invalid JSON" } })
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(res, 400, { error: { message: "messages required" } })
  }

  // Only a fixed set of fields goes upstream. Reasoning models (gpt-5.x) reject
  // `temperature` and prefer `max_completion_tokens`, so neither `temperature`
  // nor `max_tokens` is forwarded. The model comes from the relay's config for the
  // request's task; whatever model the client names is ignored.
  const requested = Number(body.max_completion_tokens ?? body.max_tokens)
  const forwarded = {
    messages: body.messages,
    stream: Boolean(body.stream),
    max_completion_tokens: Math.min(requested || MAX_TOKENS, MAX_TOKENS),
    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
    ...(body.stream ? { stream_options: { include_usage: true } } : {})
  }
  const task = String(req.headers["x-meetingly-task"] ?? "")
  const models = modelsFor(MODELS, task)
  const isAnswer = ANSWER_TASKS.has(task)
  if (isAnswer && !quotas.allowAnswer(device)) {
    return json(res, 429, { error: { message: `Daily limit of ${ANSWERS_PER_DAY} free answers reached. It resets at midnight UTC.` } })
  }

  // The next model is tried only when one fails before sending anything (unknown model, rate limit, outage).
  let upstream = null
  let served = ""
  for (const [i, model] of models.entries()) {
    const last = i === models.length - 1
    try {
      upstream = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPSTREAM_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, ...forwarded }),
        signal: AbortSignal.timeout(120_000)
      })
    } catch (err) {
      if (last) throw err
      console.warn(`[relay] ${model} unreachable (${task || "chat"}), trying ${models[i + 1]}: ${err.message}`)
      continue
    }
    served = model
    if (upstream.ok || last) break
    const detail = (await upstream.text().catch(() => "")).slice(0, 200)
    console.warn(`[relay] ${model} answered ${upstream.status} (${task || "chat"}), trying ${models[i + 1]}: ${detail}`)
  }

  quotas.countChat(device)
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store",
    "X-Meetingly-Model": served
  })
  if (!upstream.body) return res.end()
  // Stream the upstream body straight through; works for SSE and plain JSON alike. An answer
  // counts toward the daily limit once it is clear the reply really answered something.
  const watcher = isAnswer && upstream.ok ? new ReplyWatcher(Boolean(body.stream)) : null
  const decoder = new TextDecoder()
  const reader = upstream.body.getReader()
  req.on("close", () => reader.cancel().catch(() => {}))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      watcher?.push(decoder.decode(value, { stream: true }))
      res.write(value)
    }
  } finally {
    if (watcher?.verdict() === "answer") quotas.countAnswer(device)
  }
  res.end()
}

function proxyListen(client, url, device) {
  const params = new URLSearchParams()
  for (const [k, v] of url.searchParams) if (ALLOWED_LISTEN_PARAMS.has(k)) params.set(k, v)
  params.set("model", "nova-2")
  if (!params.has("encoding")) params.set("encoding", "linear16")
  if (!params.has("sample_rate")) params.set("sample_rate", "16000")

  const upstream = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
  })
  const startedAt = Date.now()
  const queued = []
  let closed = false

  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return
    closed = true
    quotas.countAudio(device, (Date.now() - startedAt) / 60000)
    try { client.close(code, reason) } catch {}
    try { upstream.close(code, reason) } catch {}
  }

  upstream.on("open", () => {
    for (const msg of queued.splice(0)) upstream.send(msg)
  })
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  upstream.on("close", (code, reason) => closeBoth(code === 1005 ? 1000 : code, reason.toString()))
  upstream.on("error", (err) => {
    console.warn("[relay] deepgram error:", err.message)
    closeBoth(1011, "upstream error")
  })
  upstream.on("unexpected-response", (_req, res) => {
    console.warn("[relay] deepgram refused:", res.statusCode)
    closeBoth(1011, `upstream ${res.statusCode}`)
  })

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
    else if (queued.length < 200) queued.push(data)
  })
  client.on("close", () => closeBoth())
  client.on("error", () => closeBoth(1011, "client error"))
}

// ---------------------------------------------------------------------------

function authenticate(req, url) {
  const header = req.headers.authorization ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token")
  if (!token || !safeEqual(token, APP_TOKEN)) return { ok: false, reason: "Invalid app token" }
  const device = String(req.headers["x-device-id"] ?? url.searchParams.get("device") ?? "").slice(0, 64)
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(device)) return { ok: false, reason: "Missing device id" }
  return { ok: true, device }
}

function safeEqual(a, b) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const real = req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
    if (real) return real
  }
  return req.socket.remoteAddress ?? "unknown"
}

function createServer(handler) {
  if (env.TLS_CERT && env.TLS_KEY) {
    const options = { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) }
    const srv = https.createServer(options, handler)
    // Pick up renewed certificates without a restart.
    setInterval(() => {
      try {
        srv.setSecureContext({ cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) })
      } catch (err) {
        console.warn("[relay] cert reload failed:", err.message)
      }
    }, 6 * 3600 * 1000).unref()
    return srv
  }
  console.warn("[relay] TLS_CERT/TLS_KEY not set, serving plain HTTP (dev only)")
  return http.createServer(handler)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error("Body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(payload))
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function required(name) {
  const v = env[name]
  if (!v) {
    console.error(`[relay] ${name} is required`)
    process.exit(1)
  }
  return v.trim()
}

export { path }
