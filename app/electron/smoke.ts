import { app } from "electron"
import { spawn } from "node:child_process"
import fs from "node:fs"
import type { AsrModel } from "./services/asrModel"
import { LocalAsrSocket } from "./services/localAsr"
import type { AudioSource, WindowKind } from "../shared/types"
import type { ChatService } from "./services/chat"
import type { CloudSync } from "./services/cloud"
import type { MeetingStore } from "./services/meetings"
import type { RecordingSession } from "./services/session"
import type { SettingsStore } from "./services/settings"
import type { WindowManager } from "./windows/WindowManager"
import { SUGGESTIONS_WIDTH } from "./windows/config"

const KINDS: WindowKind[] = ["main", "chat", "dashboard"]

interface SmokeDeps {
  windows: WindowManager
  chat: ChatService
  session: RecordingSession
  settings: SettingsStore
  cloud: CloudSync
  meetings: MeetingStore
  asrModel: AsrModel
}

/**
 * Self checks driven by the IGPT_SMOKE env var:
 *   "1"       open every window, collect renderer errors, print a JSON report, exit.
 *   "chat"    same, plus one real chat round-trip through the relay.
 *   "listen"  same, plus a real listening session with the microphone and with
 *             system audio: the transcription socket must open and the renderer
 *             must keep the session in "recording" (capture errors pause it).
 *   "visual"  open every window with content protection off and stay running
 *             so the screen can be captured.
 *   "answers" auto-answer against the real model: English and Russian questions must get
 *             direct answers, small talk must be skipped (nothing shown in chat).
 *   "shots"   capture the toolbar and both panel tabs (with sample answers) as PNGs into
 *             IGPT_SMOKE_SHOTS. capturePage works even with content protection on.
 *   "asr"     on-device transcription: stream IGPT_SMOKE_WAV (16 kHz mono, played on the IGPT_SMOKE_SIDE
 *             channel, default "them") through the
 *             speech worker in real time and report partials, finals and latency.
 */
export async function runSmokeTest(mode: string, { windows, chat, session, settings, cloud, meetings, asrModel }: SmokeDeps): Promise<void> {
  const errors: string[] = []
  const loaded = new Set<WindowKind>()

  const attach = (kind: WindowKind) => {
    const win = windows.get(kind)
    if (!win) return
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(`[${kind}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    })
    win.webContents.on("did-fail-load", (_e, code, desc) => errors.push(`[${kind}] did-fail-load ${code} ${desc}`))
    win.webContents.on("render-process-gone", (_e, details) => errors.push(`[${kind}] renderer gone: ${details.reason}`))
    win.webContents.on("did-finish-load", () => loaded.add(kind))
  }

  attach("main")
  for (const kind of KINDS) {
    if (kind !== "main") {
      windows.show(kind)
      attach(kind)
    }
  }
  if (mode === "visual") windows.setStealth(false)

  await sleep(mode === "visual" ? 3000 : 6000)

  let chatProbe: { ok: boolean; reply?: string; error?: string; ms: number } | undefined
  if (mode === "chat") {
    const started = Date.now()
    const done = new Promise<{ ok: boolean; reply?: string; error?: string }>((resolve) => {
      chat.once("message", () => {
        chat.once("message", (m) => resolve(m.kind === "error" ? { ok: false, error: m.text } : { ok: true, reply: m.text }))
      })
    })
    await chat.send("Reply with exactly three words confirming you work.")
    chatProbe = { ...(await Promise.race([done, sleep(45000).then(() => ({ ok: false, error: "timeout" }))])), ms: Date.now() - started }
  }

  const listenProbe: Record<string, { ok: boolean; status: string; connected: boolean; notice: string | null; transcript?: string; heardPhrase?: boolean }> = {}
  if (mode === "listen") {
    const original = settings.get()
    for (const source of ["microphone", "system", "both"] as AudioSource[]) {
      settings.update({ audioSource: source, audioDeviceId: "", autoAnswer: "off" })
      try {
        await session.start()
        await sleep(2500)
        // System audio: play a known phrase through the speakers and expect it in the transcript.
        const spoke = source !== "microphone" ? await speakOnWindows(TEST_PHRASE) : false
        await sleep(spoke ? 9000 : 6000)
        const state = session.state()
        const transcript = session.transcriptText()
        // Diarization may split one sentence across speaker lines; compare words only.
        const words = transcript.toLowerCase().replace(/speaker \d+:/g, " ").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ")
        const heardPhrase = spoke ? words.includes("purple elephant") : undefined
        listenProbe[source] = {
          ok: state.status === "recording" && state.connected && heardPhrase !== false,
          status: state.status,
          connected: state.connected,
          notice: state.notice,
          transcript: transcript.slice(0, 200),
          heardPhrase
        }
      } catch (err) {
        listenProbe[source] = { ok: false, status: "error", connected: false, notice: (err as Error).message }
      }
      session.cancel()
      await sleep(1000)
    }
    settings.update({ audioSource: original.audioSource, audioDeviceId: original.audioDeviceId, autoAnswer: original.autoAnswer })
  }

  let cloudProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "cloud") cloudProbe = await cloudSmoke({ cloud, settings, meetings })

  if (mode === "shots") await shots(windows, process.env.IGPT_SMOKE_SHOTS || app.getPath("temp"))

  let answersProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "answers") answersProbe = await answersSmoke(chat, settings)

  let asrProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "asr") asrProbe = await asrSmoke(asrModel, process.env.IGPT_SMOKE_WAV ?? "", process.env.IGPT_SMOKE_LANG ?? "en-US")

  const report = {
    mode,
    ok:
      errors.length === 0 &&
      loaded.size === KINDS.length &&
      (chatProbe?.ok ?? true) &&
      Object.values(listenProbe).every((p) => p.ok) &&
      (cloudProbe?.ok ?? true) &&
      (asrProbe?.ok ?? true) &&
      (answersProbe?.ok ?? true),
    loaded: [...loaded],
    windows: Object.fromEntries(
      KINDS.map((k) => {
        const win = windows.get(k)
        return [k, win ? { visible: win.isVisible(), bounds: win.getBounds() } : null]
      })
    ),
    chat: chatProbe,
    listen: mode === "listen" ? listenProbe : undefined,
    cloud: cloudProbe,
    asr: asrProbe,
    answers: answersProbe,
    errors
  }
  console.log(`SMOKE_REPORT ${JSON.stringify(report)}`)
  if (mode !== "visual") app.exit(report.ok ? 0 : 1)
}

const TEST_PHRASE = "The purple elephant is testing system audio capture."

/** Render sample content into the panel and save each window as a PNG (with alpha) plus its bounds. */
async function shots(windows: WindowManager, dir: string): Promise<void> {
  const now = Date.now()
  const sample = [
    { id: "s1", role: "user", kind: "auto", text: "What is Kafka?", timestamp: now },
    { id: "s2", role: "assistant", kind: "auto", text: "**Kafka is a distributed event-streaming platform for publishing, storing and processing real-time data.**\n- Producers write to topics\n- Consumers read at their own pace\n- Partitions scale it out\n- Replicated, so durable", timestamp: now },
    { id: "s3", role: "user", kind: "auto", text: "How would you scale the database as traffic grows?", timestamp: now },
    { id: "s4", role: "assistant", kind: "auto", text: "**I'd scale it in stages: find the bottleneck, fix queries and indexes, then add read replicas and shard by key.**\n- Profile the load first\n- Indexes and query plans\n- Read replicas for reads\n- Shard by merchant ID", timestamp: now }
  ] as const
  // A session in progress with the suggestions rail; "paused" shows it without starting audio capture.
  windows.setPanelExtra(SUGGESTIONS_WIDTH)
  windows.showPanel("answers")
  await sleep(1500)
  windows.send("chat", "session:state", { status: "paused", startedAt: now, notice: null, connected: true, audioSource: "both", audioDeviceId: "" })
  windows.send("chat", "suggestions:state", {
    topic: "Scaling the payments database",
    items: [
      { id: "q1", text: "What is database sharding and when is it needed?" },
      { id: "q2", text: "How does replication differ from sharding?" },
      { id: "q3", text: "How do you choose a shard key for a payments service?" },
      { id: "q4", text: "What is consumer lag in Kafka and how do you monitor it?" }
    ],
    updating: false
  })
  for (const m of sample) windows.send("chat", "chat:message", { ...m })
  await sleep(800)
  const save = async (name: string) => {
    for (const kind of ["main", "chat"] as WindowKind[]) {
      const win = windows.get(kind)
      if (!win) continue
      const img = await win.webContents.capturePage()
      fs.writeFileSync(`${dir}/${name}-${kind}.png`, img.toPNG())
      fs.writeFileSync(`${dir}/${name}-${kind}.json`, JSON.stringify(win.getBounds()))
    }
  }
  await save("answers")
  windows.showPanel("transcript")
  const said: [string, "you" | "them", boolean][] = [
    ["Thanks for joining! Tell me a bit about yourself and your experience.", "them", true],
    ["Hi! I've been a backend engineer for five years, mostly Go and Kafka.", "you", true],
    ["For the last two years I've owned our payments service.", "you", true],
    ["Great. How would you scale the database as traffic grows?", "them", true],
    ["And what would you do first if latency doubled overnight", "them", false]
  ]
  await sleep(400)
  for (const [text, channel, isFinal] of said) {
    windows.send("chat", "session:transcript", { text, isFinal, speechFinal: isFinal, confidence: 1, speaker: null, channel })
    await sleep(60)
  }
  await sleep(600)
  await save("transcript")
}

/** Real model round-trips through ChatService.autoAnswer (relay, current default prompt). */
async function answersSmoke(chat: ChatService, settings: SettingsStore): Promise<Record<string, unknown> & { ok: boolean }> {
  const cases: { lang: "en" | "ru"; text: string; expect: "answer" | "skip" }[] = [
    { lang: "en", text: "What is Kafka?", expect: "answer" },
    { lang: "en", text: "So how would you design a rate limiter for a public API", expect: "answer" },
    { lang: "en", text: "Tell me about a time you disagreed with your manager.", expect: "answer" },
    { lang: "en", text: "Thanks, that makes sense, let's move on to the next part.", expect: "skip" },
    { lang: "ru", text: "Что такое Kafka?", expect: "answer" },
    { lang: "ru", text: "Расскажите, как бы вы масштабировали базу данных.", expect: "answer" },
    { lang: "ru", text: "Хорошо, понятно, спасибо.", expect: "skip" }
  ]
  const original = settings.get()
  const results: Record<string, unknown>[] = []
  for (const c of cases) {
    settings.update({ autoAnswer: "questions", outputLanguage: c.lang, audioLanguage: c.lang })
    chat.clear()
    let answer: string | null = null
    const onAnswer = (m: { text: string }) => { answer = m.text }
    chat.on("auto-answer", onAnswer)
    const started = Date.now()
    await chat.autoAnswer({ text: c.text, speaker: null, timestamp: Date.now() })
    chat.off("auto-answer", onAnswer)
    const got = answer === null ? "skip" : "answer"
    results.push({ heard: c.text, expect: c.expect, got, ok: got === c.expect, ms: Date.now() - started, answer })
  }
  settings.update({ autoAnswer: original.autoAnswer, outputLanguage: original.outputLanguage, audioLanguage: original.audioLanguage })
  return { ok: results.every((r) => r.ok), results }
}

/** Read a 16 kHz mono WAV (16-bit PCM or 32-bit float) as signed 16-bit samples. */
function readWav16k(file: string): Int16Array {
  const buf = fs.readFileSync(file)
  let off = 12
  let format = 1
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === "fmt ") format = buf.readUInt16LE(off + 8)
    if (id === "data") {
      const data = buf.subarray(off + 8, off + 8 + size)
      if (format === 3) {
        const f = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~3)))
        return Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))))
      }
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)))
    }
    off += 8 + size + (size % 2)
  }
  throw new Error("no audio data in " + file)
}

/** Feed a recording through the speech worker at real-time pace (100 ms chunks), plus 1.5 s of silence. */
async function asrSmoke(model: AsrModel, wav: string, language: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const started = Date.now()
  const socket = new LocalAsrSocket({ language, model })
  const finals: { text: string; speechFinal: boolean; channel: unknown; atMs: number }[] = []
  let partials = 0
  const workerErrors: string[] = []
  socket.on("error", (e: Error) => workerErrors.push(e.message))
  let firstPartialMs: number | null = null
  socket.on("transcript", (e: { text: string; isFinal: boolean; speechFinal: boolean; channel?: unknown }) => {
    if (e.isFinal) finals.push({ text: e.text, speechFinal: e.speechFinal, channel: e.channel, atMs: Date.now() - started })
    else {
      partials++
      if (firstPartialMs === null) firstPartialMs = Date.now() - started
    }
  })
  try {
    await socket.connect()
    const readyMs = Date.now() - started
    const pcm = readWav16k(wav)
    // Stereo like the capture: the recording plays on the system-audio side ("them"), the mic is silent.
    const side = process.env.IGPT_SMOKE_SIDE === "you" ? 0 : 1
    const frames = pcm.length + 24000
    const stereo = new Int16Array(frames * 2)
    for (let i = 0; i < pcm.length; i++) stereo[2 * i + side] = pcm[i]
    const feedStart = Date.now()
    for (let f = 0; f < frames; f += 1600) {
      socket.sendAudio(stereo.slice(2 * f, 2 * Math.min(frames, f + 1600)).buffer)
      await sleep(100)
    }
    await sleep(1500)
    socket.close()
    await sleep(800)
    return {
      ok: finals.length > 0,
      readyMs,
      audioSeconds: +(pcm.length / 16000).toFixed(1),
      firstPartialMs: firstPartialMs === null ? null : firstPartialMs - (feedStart - started),
      partials,
      finals,
      workerErrors
    }
  } catch (err) {
    socket.close()
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Account linking and two-way sync against a real server. Needs:
 *   IGPT_CLOUD_URL          the PocketBase base URL (an ssh tunnel to production works)
 *   IGPT_SMOKE_USER/_PASS   an existing account that plays the "browser" side
 * Ends with the device unlinked again.
 */
async function cloudSmoke({ cloud, settings, meetings }: Pick<SmokeDeps, "cloud" | "settings" | "meetings">): Promise<Record<string, unknown> & { ok: boolean }> {
  const base = (process.env.IGPT_CLOUD_URL ?? "").replace(/\/+$/, "")
  const identity = process.env.IGPT_SMOKE_USER
  const password = process.env.IGPT_SMOKE_PASS
  const steps: Record<string, unknown> = {}
  const fail = (step: string, detail: unknown) => ({ ok: false, failedAt: step, detail, steps })
  if (!base || !identity || !password) return fail("env", "IGPT_CLOUD_URL, IGPT_SMOKE_USER and IGPT_SMOKE_PASS are required")

  const json = async (url: string, init: RequestInit & { token?: string } = {}) => {
    const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: init.token } : {}), ...(init.headers ?? {}) } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    return body as Record<string, any>
  }
  const waitFor = async (what: string, check: () => boolean | Promise<boolean>, ms = 15000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return true
      await sleep(400)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  try {
    // Seed one local meeting so the upload path is exercised.
    if (meetings.list().length === 0) {
      meetings.save({
        id: `smoke_${Date.now()}`,
        title: "Smoke meeting",
        startTime: Date.now() - 60000,
        endTime: Date.now(),
        duration: 60000,
        transcript: [{ text: "hello from the smoke test", timestamp: Date.now(), confidence: 1, speaker: 0 }],
        fullTranscriptText: "hello from the smoke test",
        language: "en",
        status: "completed",
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }
    if (settings.get().cloud) await cloud.unlink()

    // 1. app side: start linking (no browser is opened in smoke mode)
    const started = await cloud.linkStart()
    steps.code = started.code
    if (!started.code) return fail("link-start", started)

    // 2. browser side: sign in and claim the code
    const auth = await json(`${base}/api/collections/users/auth-with-password`, { method: "POST", body: JSON.stringify({ identity, password }) })
    const userToken = auth.token as string
    const userId = auth.record.id as string
    await json(`${base}/api/igpt/link/claim`, { method: "POST", token: userToken, body: JSON.stringify({ code: started.code }) })

    // 3. app side: poll picks the token up and goes online
    await waitFor("cloud online", () => cloud.state().status === "online", 20000)
    steps.linkedAs = cloud.state().email

    // 4. server has profile, prompts and the meeting
    const profiles = await json(`${base}/api/collections/profiles/records?filter=${encodeURIComponent(`user="${userId}"`)}`, { token: userToken })
    steps.profile = profiles.totalItems
    const prompts = await json(`${base}/api/collections/prompts/records`, { token: userToken })
    steps.prompts = prompts.totalItems
    const remoteMeetings = await json(`${base}/api/collections/meetings/records`, { token: userToken })
    steps.meetings = remoteMeetings.totalItems
    if (profiles.totalItems !== 1 || prompts.totalItems < 1 || remoteMeetings.totalItems < 1) return fail("initial-upload", steps)

    // 5. remote -> local (realtime): change a setting in the "browser"
    const profile = profiles.items[0]
    const before = settings.get().answerLength
    const target = before === "short" ? "medium" : "short"
    await json(`${base}/api/collections/profiles/records/${profile.id}`, { method: "PATCH", token: userToken, body: JSON.stringify({ settings: { ...profile.settings, answerLength: target }, version: (profile.version ?? 0) + 1 }) })
    await waitFor("remote setting to arrive", () => settings.get().answerLength === target, 15000)
    steps.remoteToLocal = "ok"

    // 6. local -> remote: change a setting in the app
    const lang = settings.get().outputLanguage === "fr" ? "de" : "fr"
    settings.update({ outputLanguage: lang })
    await waitFor("local setting to upload", async () => {
      const p = await json(`${base}/api/collections/profiles/records/${profile.id}`, { token: userToken })
      return p.settings?.outputLanguage === lang
    }, 15000)
    steps.localToRemote = "ok"

    // 7. prompt edited remotely shows up locally
    const promptId = prompts.items[0].id as string
    await json(`${base}/api/collections/prompts/records/${promptId}`, { method: "PATCH", token: userToken, body: JSON.stringify({ notes: "smoke background note" }) })
    await waitFor("remote prompt edit", () => settings.get().prompts.some((p) => p.notes === "smoke background note"), 15000)
    steps.promptSync = "ok"

    // 8. clean up: restore and unlink
    settings.update({ answerLength: before, outputLanguage: "en" })
    await sleep(1500)
    await cloud.unlink()
    steps.unlinked = cloud.state().status
    return { ok: cloud.state().status === "off", steps }
  } catch (err) {
    return fail("exception", (err as Error).message)
  }
}

/** Windows text-to-speech through the default speakers; resolves false where unavailable. */
function speakOnWindows(text: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false)
  return new Promise((resolve) => {
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume = 100; $s.Speak('${text.replace(/'/g, "''")}')`
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true })
    child.on("error", () => resolve(false))
    child.on("exit", (code) => resolve(code === 0))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
