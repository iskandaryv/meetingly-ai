import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { app, utilityProcess, type UtilityProcess } from "electron"
import type { TranscriptEvent } from "../../shared/types"
import type { AsrModel } from "./asrModel"
import { t } from "../../shared/i18n"

const READY_TIMEOUT_MS = 60000

/** Folder holding the transcribe.cpp native library for this platform. */
export function nativeLibDir(): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"
  if (app.isPackaged) return path.join(process.resourcesPath, "transcribe")
  return path.join(app.getAppPath(), "vendor", "transcribe", `${platform}-${process.arch}`)
}

/**
 * On-device transcription with the same surface as DeepgramSocket, so the
 * recording session can use either. The model runs in a utility process
 * (dist-electron/asr-worker.js); see electron/asr-worker.ts.
 *
 * Events: "open", "close" (code, reason, byUs), "error" (Error), "transcript" (TranscriptEvent),
 *         "progress" (percent while the model downloads)
 */
export class LocalAsrSocket extends EventEmitter {
  private child: UtilityProcess | null = null
  private ready = false
  /** Takes the capture's stereo stream and transcribes microphone and system audio separately. */
  readonly stereo = true
  private closedByUs = false

  constructor(private readonly opts: { language: string; model: AsrModel }) {
    super()
  }

  get isOpen(): boolean {
    return this.ready
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

      child.on("message", (msg: { type: string; channel?: number; text?: string; speechFinal?: boolean; message?: string }) => {
        switch (msg.type) {
          case "ready":
            clearTimeout(timer)
            this.ready = true
            this.emit("open")
            resolve()
            break
          case "partial":
          case "final": {
            const event: TranscriptEvent = {
              text: msg.text ?? "",
              isFinal: msg.type === "final",
              speechFinal: msg.type === "final" && Boolean(msg.speechFinal),
              confidence: 1,
              speaker: null,
              channel: msg.channel === 0 ? "you" : "them"
            }
            if (event.text) this.emit("transcript", event)
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
        threads: Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)))
      })
    })
  }

  sendAudio(pcm16: Buffer | ArrayBuffer | Uint8Array): void {
    if (!this.ready || !this.child) return
    const bytes = pcm16 instanceof ArrayBuffer ? new Uint8Array(pcm16) : new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
    // Copy into a fresh ArrayBuffer of whole stereo frames (Int16 L/R pairs on the worker side).
    const even = bytes.byteLength - (bytes.byteLength % 4)
    this.child.postMessage({ type: "audio", pcm: bytes.slice(0, even).buffer })
  }

  close(): void {
    this.closedByUs = true
    this.ready = false
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
