/**
 * On-device transcription worker (Electron utility process).
 *
 * Runs NVIDIA Nemotron 3.5 ASR Streaming through the transcribe.cpp native
 * library, called over FFI (koffi). Lives in its own process so inference never
 * blocks the app and a native crash cannot take the app down.
 *
 * Protocol (parentPort messages):
 *   in : { type: "start", libDir, modelPath, language, threads }
 *        { type: "audio", pcm: ArrayBuffer }   16 kHz stereo signed 16-bit, interleaved:
 *                                              left = microphone (you), right = system audio (them)
 *        { type: "stop" }
 *   out: { type: "ready" } | { type: "partial", channel, text } | { type: "final", channel, text, speechFinal }
 *        channel: 0 = microphone, 1 = system audio. One model, one speech session per channel.
 *        { type: "error", message } | { type: "log", message }
 *
 * Audio goes to the model continuously; an utterance ends when the transcript
 * stops growing (0.7 s after a finished sentence, 1.5 s otherwise; see Segmenter).
 */
import path from "node:path"
import os from "node:os"
import koffi from "koffi"

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

const SAMPLE_RATE = 16000
const BLOCK_SAMPLES = 2560 // 160 ms per model call
const END_AFTER_SENTENCE_MS = 700 // a finished sentence (. ? !) followed by this much quiet ends an utterance
const END_SILENCE_MS = 1500 // any text followed by this much quiet ends it too (mid-sentence pauses survive)
const MAX_UTTERANCE_MS = 30000
const PARTIAL_EVERY_MS = 150
const ATT_CONTEXT_RIGHT = 6 // 480 ms lookahead: near-offline accuracy at live latency
const EXT_KIND_PARAKEET_STREAM = 1414744912

type Fn = (...args: any[]) => any
/** One speech stream (its own session) on the shared model. */
interface Engine {
  feed(pcm: Float32Array): void
  finalize(): string
  text(): string
  begin(): void
  close(): void
}

interface Model {
  openStream(): Engine
  close(): void
}

/** Below this RMS a block is digital silence (an idle loopback channel) and is not fed to the model. */
const SILENCE_RMS = 1e-4

let model: Model | null = null

function post(msg: Record<string, unknown>): void {
  parentPort.postMessage(msg)
}

function libFile(dir: string): string {
  if (process.platform === "win32") return path.join(dir, "transcribe.dll")
  if (process.platform === "darwin") return path.join(dir, "libtranscribe.dylib")
  return path.join(dir, "libtranscribe.so")
}

function loadModel(libDir: string, modelPath: string, language: string, threads: number): Model {
  // Windows resolves ggml*.dll next to transcribe.dll only if the directory is on the search path.
  if (process.platform === "win32") process.env.PATH = `${libDir};${process.env.PATH ?? ""}`
  const lib = koffi.load(libFile(libDir))

  // Struct types are registered by name and referenced from the function signatures below.
  const Ext = koffi.struct("transcribe_ext", { size: "uint64", kind: "uint32" })
  const ParakeetExt = koffi.struct("transcribe_parakeet_stream_ext", { ext: Ext, att_context_right: "int32" })
  koffi.struct("transcribe_model_load_params", { struct_size: "uint64", backend: "int", device: "void *" })
  koffi.struct("transcribe_session_params", { struct_size: "uint64", n_threads: "int", kv_type: "int", n_ctx: "int32" })
  koffi.struct("transcribe_run_params", {
    struct_size: "uint64", task: "int", timestamps: "int", pnc: "int", itn: "int", diarize: "int",
    language: "const char *", target_language: "const char *", keep_special_tags: "bool", family: "void *", spec_k_drafts: "int32"
  })
  koffi.struct("transcribe_stream_params", { struct_size: "uint64", family: "void *", commit_policy: "int", stable_prefix_agreement_n: "uint32" })
  koffi.struct("transcribe_stream_update", {
    struct_size: "uint64", result_changed: "bool", is_final: "bool", revision: "int32", input_received_ms: "int64",
    audio_committed_ms: "int64", buffered_ms: "int64", committed_changed: "bool", tentative_changed: "bool"
  })
  koffi.struct("transcribe_stream_text", {
    struct_size: "uint64", full_text: "const char *", full_text_bytes: "uint64", committed_text: "const char *",
    committed_text_bytes: "uint64", tentative_text: "const char *", tentative_text_bytes: "uint64", raw_tentative_start_bytes: "uint64"
  })

  const fn = (sig: string): Fn => lib.func(sig)
  const initBackends = fn("int transcribe_init_backends(const char *dir)")
  const statusString = fn("const char *transcribe_status_string(int status)")
  const modelParamsInit = fn("void transcribe_model_load_params_init(_Out_ transcribe_model_load_params *p)")
  const modelLoad = fn("int transcribe_model_load_file(const char *path, transcribe_model_load_params *p, _Out_ void **out)")
  const modelFree = fn("void transcribe_model_free(void *model)")
  const sessionParamsInit = fn("void transcribe_session_params_init(_Out_ transcribe_session_params *p)")
  const sessionInit = fn("int transcribe_session_init(void *model, transcribe_session_params *p, _Out_ void **out)")
  const sessionFree = fn("void transcribe_session_free(void *session)")
  const runParamsInit = fn("void transcribe_run_params_init(_Out_ transcribe_run_params *p)")
  const streamParamsInit = fn("void transcribe_stream_params_init(_Out_ transcribe_stream_params *p)")
  const streamBegin = fn("int transcribe_stream_begin(void *session, transcribe_run_params *rp, transcribe_stream_params *sp)")
  const streamFeed = fn("int transcribe_stream_feed(void *session, float *pcm, int n, _Inout_ transcribe_stream_update *u)")
  const streamFinalize = fn("int transcribe_stream_finalize(void *session, _Inout_ transcribe_stream_update *u)")
  const streamGetText = fn("int transcribe_stream_get_text(void *session, _Inout_ transcribe_stream_text *t)")
  const streamReset = fn("void transcribe_stream_reset(void *session)")
  const streamUpdateInit = fn("void transcribe_stream_update_init(_Out_ transcribe_stream_update *u)")
  const streamTextInit = fn("void transcribe_stream_text_init(_Out_ transcribe_stream_text *t)")

  // Native log output (per-chunk timings) goes to this process's stdio, which the app does not attach.
  const check = (status: number, what: string) => {
    if (status !== 0) throw new Error(`${what}: ${statusString(status)}`)
  }
  check(initBackends(libDir), "loading compute backends")

  const mp: Record<string, unknown> = {}
  modelParamsInit(mp)
  mp.backend = Number(process.env.MEETINGLY_ASR_BACKEND ?? 1) // 1 = CPU: predictable on every machine
  const modelOut = [null]
  check(modelLoad(modelPath, mp, modelOut), "loading the speech model")
  const handle = modelOut[0]

  // Stream extension: 480 ms lookahead. Kept alive for the life of the model.
  const ext = koffi.alloc(ParakeetExt, 1)
  koffi.encode(ext, ParakeetExt, { ext: { size: koffi.sizeof(ParakeetExt), kind: EXT_KIND_PARAKEET_STREAM }, att_context_right: ATT_CONTEXT_RIGHT })
  const sessions: unknown[] = []

  // Calls into the sessions are sequential (this thread), which the library requires per model.
  const openStream = (): Engine => {
  const spar: Record<string, unknown> = {}
  sessionParamsInit(spar)
  spar.n_threads = threads
  const sessionOut = [null]
  check(sessionInit(handle, spar, sessionOut), "opening a speech session")
  const session = sessionOut[0]
  sessions.push(session)

  const readText = (): string => {
    const t: Record<string, unknown> = {}
    streamTextInit(t)
    check(streamGetText(session, t), "reading the transcript")
    // full_text is the model's whole hypothesis with its own spacing; gluing committed + tentative
    // dropped the space at the seam ("I'mI'm").
    const full = String(t.full_text ?? "") || String(t.committed_text ?? "") + String(t.tentative_text ?? "")
    return full.replace(/<[a-z]{2}-[A-Z]{2}>/g, "").replace(/\s+/g, " ").trim()
  }

  const begin = () => {
    const rp: Record<string, unknown> = {}
    runParamsInit(rp)
    rp.language = language
    const sp: Record<string, unknown> = {}
    streamParamsInit(sp)
    sp.family = ext
    check(streamBegin(session, rp, sp), "starting the stream")
  }
  begin()

  return {
    feed(pcm) {
      const u: Record<string, unknown> = {}
      streamUpdateInit(u)
      check(streamFeed(session, pcm, pcm.length, u), "transcribing")
    },
    finalize() {
      const u: Record<string, unknown> = {}
      streamUpdateInit(u)
      check(streamFinalize(session, u), "finishing the utterance")
      const text = readText()
      streamReset(session)
      return text
    },
    text: readText,
    begin,
    close() {
      try { streamReset(session) } catch { /* already reset */ }
    }
  }
  }

  return {
    openStream,
    close() {
      for (const session of sessions) sessionFree(session)
      modelFree(handle)
      koffi.free(ext)
    }
  }
}

/**
 * Utterance bookkeeping. Audio is fed to the model continuously (in 160 ms
 * blocks) and the model's own output decides what speech is: an utterance ends
 * when its text stops growing: after 0.7 s if it ends a sentence, after 1.5 s
 * otherwise, so readers who pause mid-sentence are not cut in two. Loudness
 * thresholds were tried first and failed: real inputs range from speech peaking
 * at 0.015 to background noise sitting at 0.03.
 */
class Segmenter {
  private block: Float32Array[] = []
  private blockSamples = 0
  private audioMs = 0
  private text = ""
  private lastChangeMs = 0
  private utteranceStartMs = -1
  private lastPartialMs = -PARTIAL_EVERY_MS
  stats = { chunks: 0, feeds: 0, skipped: 0, utterances: 0 }

  constructor(private readonly asr: Engine, private readonly channel: number) {}

  push(pcm16: Int16Array): void {
    this.stats.chunks++
    const f = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) f[i] = pcm16[i] / 32768
    this.block.push(f)
    this.blockSamples += f.length
    if (this.blockSamples >= BLOCK_SAMPLES) this.flushBlock()
  }

  private flushBlock(): void {
    const joined = new Float32Array(this.blockSamples)
    let o = 0
    for (const b of this.block) { joined.set(b, o); o += b.length }
    this.block = []
    this.blockSamples = 0
    this.audioMs += (joined.length / SAMPLE_RATE) * 1000
    let sum = 0
    for (let i = 0; i < joined.length; i++) sum += joined[i] * joined[i]
    if (Math.sqrt(sum / joined.length) < SILENCE_RMS) {
      // Idle channel: no model call. A pending utterance still ends on time below; finalize flushes it.
      this.stats.skipped++
    } else {
      this.asr.feed(joined)
      this.stats.feeds++
    }

    const text = this.asr.text()
    if (text !== this.text) {
      if (!this.text && text) this.utteranceStartMs = this.audioMs
      this.text = text
      this.lastChangeMs = this.audioMs
      if (text && this.audioMs - this.lastPartialMs >= PARTIAL_EVERY_MS) {
        this.lastPartialMs = this.audioMs
        post({ type: "partial", channel: this.channel, text })
      }
    }
    if (!this.text) return
    const quietFor = this.audioMs - this.lastChangeMs
    const sentenceDone = /[.?!。？！]["')\]]?$/.test(this.text)
    if (quietFor >= END_SILENCE_MS || (sentenceDone && quietFor >= END_AFTER_SENTENCE_MS)) this.endUtterance(true)
    else if (this.audioMs - this.utteranceStartMs >= MAX_UTTERANCE_MS) this.endUtterance(false)
  }

  endUtterance(speechFinal: boolean): void {
    if (this.blockSamples > 0) {
      const rest = this.block
      this.block = []
      this.blockSamples = 0
      const joined = new Float32Array(rest.reduce((n, b) => n + b.length, 0))
      let o = 0
      for (const b of rest) { joined.set(b, o); o += b.length }
      this.asr.feed(joined)
    }
    const text = this.asr.finalize()
    this.asr.begin()
    this.text = ""
    this.utteranceStartMs = -1
    if (text) {
      this.stats.utterances++
      post({ type: "final", channel: this.channel, text, speechFinal })
    }
  }
}

let segmenters: Segmenter[] = []

parentPort.on("message", (event: { data: any }) => {
  const msg = event.data
  try {
    if (msg.type === "start") {
      const started = Date.now()
      const threads = Math.max(2, Math.min(4, Number(msg.threads) || Math.floor(os.cpus().length / 2)))
      model = loadModel(msg.libDir, msg.modelPath, msg.language, threads)
      segmenters = [new Segmenter(model.openStream(), 0), new Segmenter(model.openStream(), 1)]
      post({ type: "log", message: `model ready in ${Date.now() - started} ms, ${threads} threads, ${msg.language}, 2 channels` })
      post({ type: "ready" })
    } else if (msg.type === "audio" && segmenters.length === 2) {
      const pcm = msg.pcm instanceof ArrayBuffer ? new Int16Array(msg.pcm) : new Int16Array(msg.pcm.buffer, msg.pcm.byteOffset, msg.pcm.byteLength >> 1)
      const frames = pcm.length >> 1
      const left = new Int16Array(frames)
      const right = new Int16Array(frames)
      for (let i = 0; i < frames; i++) {
        left[i] = pcm[2 * i]
        right[i] = pcm[2 * i + 1]
      }
      segmenters[0].push(left)
      segmenters[1].push(right)
    } else if (msg.type === "stop") {
      for (const sg of segmenters) sg.endUtterance(true)
      post({ type: "log", message: `stats ${JSON.stringify(segmenters.map((sg) => sg.stats))}` })
      model?.close()
      model = null
      segmenters = []
      process.exit(0)
    }
  } catch (err) {
    post({ type: "error", message: (err as Error).message })
  }
})
