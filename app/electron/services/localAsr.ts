import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { app, utilityProcess, type UtilityProcess } from "electron"
import type { TranscriptEvent } from "../../shared/types"
import type { AsrModel } from "./asrModel"
import { RefineQueue, type FinalText } from "./refineQueue"
import { t } from "../../shared/i18n"

const READY_TIMEOUT_MS = 60000

/** Folder holding the transcribe.cpp native library for this platform. */
export function nativeLibDir(): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"
  if (app.isPackaged) return path.join(process.resourcesPath, "transcribe")
  return path.join(app.getAppPath(), "vendor", "transcribe", `${platform}-${process.arch}`)
}

/** The second pass for this session: a whole-utterance model on disk and the language code it takes (refine.ts). */
export interface RefineOptions {
  modelPath: string
  language: string
}

/**
 * On-device transcription with the same surface as DeepgramSocket, so the
 * recording session can use either. The model runs in a utility process
 * (dist-electron/asr-worker.js); see electron/asr-worker.ts.
 *
 * With `refine`, a second process holds a more accurate whole-utterance model: each finished utterance is written
 * again by it before it goes out as final (the live words stay the streaming model's). If it is slow or fails, the
 * streaming model's text goes out instead, so nothing waits long.
 *
 * Events: "open", "close" (code, reason, byUs), "error" (Error), "transcript" (TranscriptEvent),
 *         "progress" (percent while the model downloads)
 */
export class LocalAsrSocket extends EventEmitter {
  private child: UtilityProcess | null = null
  private refiner: UtilityProcess | null = null
  private refinerReady = false
  private readonly queue: RefineQueue
  /** The live words of the utterance in progress on each channel (shown after the text still being refined). */
  private readonly live = new Map<number, string>()
  private ready = false
  /** Takes the capture's stereo stream and transcribes microphone and system audio separately. */
  readonly stereo = true
  private closedByUs = false
  readonly stats = { utterances: 0, refined: 0, refineMs: 0 }

  constructor(private readonly opts: { language: string; model: AsrModel; refine?: RefineOptions | null }) {
    super()
    this.queue = new RefineQueue((final, refined) => this.emitFinal(final, refined))
  }

  get isOpen(): boolean {
    return this.ready
  }

  /** The second pass is loaded and taking utterances. */
  get refining(): boolean {
    return this.refinerReady
  }

  /** Utterances waiting for their second pass. */
  get waiting(): number {
    return this.queue.size
  }

  async connect(): Promise<void> {
    const onProgress = (p: number) => this.emit("progress", p)
    this.opts.model.on("progress", onProgress)
    let modelPath: string
    try {
      modelPath = await this.opts.model.ensure()
    } finally {
      this.opts.model.off("progress", onProgress)
    }
    if (this.closedByUs) throw new Error("stopped")

    const child = utilityProcess.fork(path.join(__dirname, "asr-worker.js"), [], {
      serviceName: "Meetingly speech recognition",
      stdio: "ignore"
    })
    this.child = child

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(t("The speech model took too long to start.")))
        child.kill()
      }, READY_TIMEOUT_MS)

      child.on("message", (msg: { type: string; channel?: number; text?: string; speechFinal?: boolean; message?: string; audio?: ArrayBuffer }) => {
        switch (msg.type) {
          case "ready":
            clearTimeout(timer)
            this.ready = true
            this.emit("open")
            resolve()
            break
          case "partial": {
            const channel = msg.channel ?? 1
            this.live.set(channel, msg.text ?? "")
            this.emitPartial(channel)
            break
          }
          case "final": {
            const channel = msg.channel ?? 1
            this.live.delete(channel)
            this.onFinal({ channel, text: msg.text ?? "", speechFinal: Boolean(msg.speechFinal) }, msg.audio)
            break
          }
          case "error": {
            const err = new Error(msg.message ?? "speech recognition failed")
            if (!this.ready) {
              clearTimeout(timer)
              reject(err)
            }
            this.emit("error", err)
            break
          }
          case "log":
            console.info("[asr]", msg.message)
            break
        }
      })
      child.on("exit", (code) => {
        clearTimeout(timer)
        const wasReady = this.ready
        this.ready = false
        this.child = null
        if (!wasReady) reject(new Error(t("The speech engine stopped unexpectedly (code {code}).", { code: String(code) })))
        this.emit("close", code, "speech worker exited", this.closedByUs)
      })

      child.postMessage({
        type: "start",
        libDir: nativeLibDir(),
        modelPath,
        language: this.opts.language,
        threads: Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2))),
        keepAudio: Boolean(this.opts.refine)
      })
    })
    if (this.opts.refine) this.startRefiner(this.opts.refine)
  }

  /** The second pass starts next to the live model; until it is ready, utterances go out as the live model wrote them. */
  private startRefiner(refine: RefineOptions): void {
    const child = utilityProcess.fork(path.join(__dirname, "asr-worker.js"), [], { serviceName: "Meetingly speech recognition (second pass)", stdio: "ignore" })
    this.refiner = child
    child.on("message", (msg: { type: string; id?: number; text?: string; ms?: number; message?: string }) => {
      if (msg.type === "ready") this.refinerReady = true
      else if (msg.type === "refined" && msg.id) {
        this.stats.refineMs += msg.ms ?? 0
        this.queue.resolve(msg.id, msg.text ?? "")
      } else if (msg.type === "error") console.warn("[asr] second pass:", msg.message)
      else if (msg.type === "log") console.info("[asr]", msg.message)
    })
    child.on("exit", (code) => {
      if (this.refiner !== child) return
      this.refiner = null
      this.refinerReady = false
      if (!this.closedByUs) console.warn(`[asr] second pass stopped (code ${code}); utterances go out as transcribed live`)
      this.queue.flush()
    })
    // A quarter of the cores (2 to 4): it only works for a moment after each utterance.
    child.postMessage({ type: "start-refine", libDir: nativeLibDir(), modelPath: refine.modelPath, threads: Math.max(2, Math.min(4, Math.floor(os.cpus().length / 4))) })
  }

  private onFinal(final: FinalText, audio: ArrayBuffer | undefined): void {
    this.stats.utterances++
    // As the live model wrote it (tests compare it with the second pass).
    this.emit("live-final", final)
    if (!this.refiner || !this.refinerReady || !audio || audio.byteLength === 0 || !this.opts.refine) {
      this.queue.flush()
      this.emitFinal(final, false)
      return
    }
    const id = this.queue.hold(final)
    try {
      this.refiner.postMessage({ type: "refine", id, pcm: audio, language: this.opts.refine.language })
    } catch {
      this.queue.resolve(id, "")
    }
    this.emitPartial(final.channel)
  }

  private emitFinal(final: FinalText, refined: boolean): void {
    if (refined) this.stats.refined++
    const event: TranscriptEvent = {
      text: final.text,
      isFinal: true,
      speechFinal: final.speechFinal,
      confidence: 1,
      speaker: null,
      channel: final.channel === 0 ? "you" : "them"
    }
    if (event.text) this.emit("transcript", event)
    // The view clears a side's live words on a final: show what is still in progress there again.
    if (this.live.get(final.channel) || this.queue.waitingText(final.channel)) this.emitPartial(final.channel)
  }

  /** A channel's live words, after any of its finished text still being written again. */
  private emitPartial(channel: number): void {
    const text = [this.queue.waitingText(channel), this.live.get(channel) ?? ""].filter(Boolean).join(" ")
    if (!text) return
    const event: TranscriptEvent = { text, isFinal: false, speechFinal: false, confidence: 1, speaker: null, channel: channel === 0 ? "you" : "them" }
    this.emit("transcript", event)
  }

  sendAudio(pcm16: Buffer | ArrayBuffer | Uint8Array): void {
    if (!this.ready || !this.child) return
    const bytes = pcm16 instanceof ArrayBuffer ? new Uint8Array(pcm16) : new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
    // Copy into a fresh ArrayBuffer of whole stereo frames (Int16 L/R pairs on the worker side).
    const even = bytes.byteLength - (bytes.byteLength % 4)
    this.child.postMessage({ type: "audio", pcm: bytes.slice(0, even).buffer })
  }

  /** Utterances still being written again go out now, as the live model wrote them (the session is finishing). */
  flush(): void {
    this.queue.flush()
  }

  close(): void {
    this.closedByUs = true
    this.ready = false
    if (this.stats.utterances) console.info("[asr]", `second pass: ${this.stats.refined} of ${this.stats.utterances} utterances, ${this.stats.refined ? Math.round(this.stats.refineMs / this.stats.refined) : 0} ms each`)
    const refiner = this.refiner
    this.refiner = null
    if (refiner) {
      try {
        refiner.postMessage({ type: "stop" })
      } catch {
        /* already gone */
      }
      setTimeout(() => refiner.kill(), 1500)
    }
    const child = this.child
    if (!child) return
    try {
      child.postMessage({ type: "stop" })
    } catch {
      /* already gone */
    }
    // The worker flushes the last utterance and exits; kill it if it hangs.
    setTimeout(() => child.kill(), 1500)
  }
}
