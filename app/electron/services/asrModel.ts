import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { t } from "../../shared/i18n"

export interface ModelSpec {
  file: string
  bytes: number
  sha256: string
  /** Our mirror first, then the original. */
  urls: readonly string[]
}

const spec = (file: string, repo: string, bytes: number, sha256: string): ModelSpec => ({
  file,
  bytes,
  sha256,
  urls: [`https://meetinglyai.com/download/models/${file}`, `https://huggingface.co/handy-computer/${repo}/resolve/main/${file}`]
})

/**
 * The on-device speech model: NVIDIA Nemotron 3.5 ASR Streaming 0.6B, 5-bit
 * (Q5_K_M, GGUF). Chosen by measurement: same accuracy as 8-bit on all tested
 * languages, while 4-bit lost noticeably on German and Mandarin.
 * License: OpenMDW-1.1 (NVIDIA). Downloaded once, then kept in userData/models.
 */
export const ASR_MODEL = spec(
  "nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf", "nemotron-3.5-asr-streaming-0.6b-gguf", 559_647_200,
  "86429e8c4f7fdcf9b3312269ad1ca6669478ba7805331c4aea7a2e33e9910d65"
)

/**
 * Models that write each finished sentence again, more accurately than the live model (refine.ts). They only
 * transcribe whole sentences, so the live words stay Nemotron's. Measured on FLEURS (30 sentences per language,
 * share of words wrong, Nemotron in brackets) and on real meetings (AMI): see refine.ts.
 *   Parakeet Ultra (moondream, CC-BY-4.0), 25 European languages; better than Nemotron in all 20 of ours, usually by
 *     half or more: en 5% (12), ro 11% (29), ru 7% (15), es 2.5 (6), de 4 (11), fr 5.5 (13), it 2 (7), pt 4 (9),
 *     pl 9 (17.5), uk 5 (15), nl 6.5 (16), cs 12 (28), sv 15 (24.5), bg 9 (20), hu 13 (30.5), fi 10 (26), da 17 (26),
 *     hr 8 (25.5), sk 7.5 (24), et 13 (34); real English meetings (AMI) 9% (13) on headsets, 24% (31) on a room mic.
 *   Qwen3-ASR 0.6B (Alibaba Qwen, Apache-2.0), for Chinese, Japanese, Korean and Vietnamese, share of characters
 *     wrong (words for vi): zh 7% (21), ja 10% (15), ko 4% (10), vi 8% (15). It did worse than Nemotron on Arabic
 *     (22%, 14) and Hindi (21%, 13) and no better on Turkish, so those stay as the live model writes them.
 *   (SenseVoice Small did as well on Chinese, but its licence only covers "reference and learning purposes".)
 */
export const REFINE_MODELS = {
  parakeet: spec("parakeet-ultra-Q5_K_M.gguf", "parakeet-ultra-gguf", 549_800_864, "f6e3d8172547a3bb468e92ff395696e6d2e0371a9e52690a27741b4e8561c997"),
  qwen: spec("Qwen3-ASR-0.6B-Q5_K_M.gguf", "Qwen3-ASR-0.6B-gguf", 645_356_192, "062a7bcb18675c2fe5ffd0e8b354eac6a1ceada9b2af9ef7168746ae16b54358")
} as const

export type RefineModelId = keyof typeof REFINE_MODELS

/**
 * Finds or downloads a model (Nemotron unless told otherwise). One download at a time; callers share it.
 * Events: "progress" (percent 0-100).
 */
export class AsrModel extends EventEmitter {
  private download: Promise<string> | null = null

  constructor(private readonly dir: string, readonly model: ModelSpec = ASR_MODEL) {
    super()
  }

  get path(): string {
    return path.join(this.dir, this.model.file)
  }

  /** Present and complete (size check; the checksum is verified when downloading). */
  isReady(): boolean {
    try {
      return fs.statSync(this.path).size === this.model.bytes
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
    for (const url of this.model.urls) {
      try {
        await this.fetchFrom(url)
        return this.path
      } catch (err) {
        lastError = err as Error
        console.warn("[asr-model] download failed from", url, "-", lastError.message)
      }
    }
    throw new Error(t("Could not download the speech model: {error}", { error: lastError?.message ?? t("unknown error") }))
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
    if (have >= this.model.bytes) {
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
        const percent = Math.floor((received / this.model.bytes) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          this.emit("progress", percent)
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    if (received !== this.model.bytes) throw new Error(`incomplete download (${received} of ${this.model.bytes} bytes)`)
    const digest = hash.digest("hex")
    if (digest !== this.model.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error("checksum mismatch")
    }
    fs.renameSync(part, this.path)
  }
}
