import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"

/**
 * The on-device speech model: NVIDIA Nemotron 3.5 ASR Streaming 0.6B, 5-bit
 * (Q5_K_M, GGUF). Chosen by measurement: same accuracy as 8-bit on all tested
 * languages, while 4-bit lost noticeably on German and Mandarin.
 * License: OpenMDW-1.1 (NVIDIA). Downloaded once, then kept in userData/models.
 */
export const ASR_MODEL = {
  file: "nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf",
  bytes: 559_647_200,
  sha256: "86429e8c4f7fdcf9b3312269ad1ca6669478ba7805331c4aea7a2e33e9910d65",
  urls: [
    "https://meetinglyai.com/download/models/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf",
    "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/main/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf"
  ]
} as const

/**
 * Finds or downloads the model. One download at a time; callers share it.
 * Events: "progress" (percent 0-100).
 */
export class AsrModel extends EventEmitter {
  private download: Promise<string> | null = null

  constructor(private readonly dir: string) {
    super()
  }

  get path(): string {
    return path.join(this.dir, ASR_MODEL.file)
  }

  /** Present and complete (size check; the checksum is verified when downloading). */
  isReady(): boolean {
    try {
      return fs.statSync(this.path).size === ASR_MODEL.bytes
    } catch {
      return false
    }
  }

  ensure(): Promise<string> {
    if (this.isReady()) return Promise.resolve(this.path)
    if (!this.download) {
      this.download = this.fetchModel().finally(() => {
        this.download = null
      })
    }
    return this.download
  }

  private async fetchModel(): Promise<string> {
    fs.mkdirSync(this.dir, { recursive: true })
    let lastError: Error | null = null
    for (const url of ASR_MODEL.urls) {
      try {
        await this.fetchFrom(url)
        return this.path
      } catch (err) {
        lastError = err as Error
        console.warn("[asr-model] download failed from", url, "-", lastError.message)
      }
    }
    throw new Error(`Could not download the speech model: ${lastError?.message ?? "unknown error"}`)
  }

  private async fetchFrom(url: string): Promise<void> {
    const part = `${this.path}.part`
    // Resume a partial download when the server supports ranges.
    let have = 0
    try {
      have = fs.statSync(part).size
    } catch {
      have = 0
    }
    if (have >= ASR_MODEL.bytes) {
      fs.rmSync(part, { force: true })
      have = 0
    }
    const res = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, redirect: "follow" })
    if (res.status === 200 && have > 0) have = 0 // server ignored the range: start over
    else if (!(res.status === 200 || res.status === 206)) throw new Error(`HTTP ${res.status}`)
    if (!res.body) throw new Error("empty response")

    const hash = createHash("sha256")
    if (have > 0) {
      // Hash the bytes we already have so the checksum covers the whole file.
      await new Promise<void>((resolve, reject) => {
        fs.createReadStream(part).on("data", (c) => hash.update(c)).on("end", () => resolve()).on("error", reject)
      })
    }
    const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" })
    let received = have
    let lastPercent = -1
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.length
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()))
        const percent = Math.floor((received / ASR_MODEL.bytes) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          this.emit("progress", percent)
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    if (received !== ASR_MODEL.bytes) throw new Error(`incomplete download (${received} of ${ASR_MODEL.bytes} bytes)`)
    const digest = hash.digest("hex")
    if (digest !== ASR_MODEL.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error("checksum mismatch")
    }
    fs.renameSync(part, this.path)
  }
}
