import { EventEmitter } from "node:events"
import WebSocket from "ws"
import { APP_TOKEN, relayWsUrl } from "../../shared/relay"
import type { TranscriptEvent } from "../../shared/types"

export interface DeepgramOptions {
  /** Per-install id sent to the relay for quotas. */
  deviceId: string
  language: string
  sampleRate?: number
  /** Override the relay base URL (tests, development). */
  relayUrl?: string
}

const KEEP_ALIVE_MS = 8000
const OPEN_TIMEOUT_MS = 15000

/**
 * One live-transcription socket, opened through the relay (which holds the
 * Deepgram key). No reconnect logic here; the recording session decides
 * whether to open a new one when this closes.
 *
 * Events: "open", "close" (code, reason), "error" (Error), "transcript" (TranscriptEvent)
 */
export class DeepgramSocket extends EventEmitter {
  private ws: WebSocket | null = null
  private keepAlive: NodeJS.Timeout | null = null
  private closedByUs = false

  constructor(private readonly opts: DeepgramOptions) {
    super()
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    const params = new URLSearchParams({
      language: this.opts.language,
      encoding: "linear16",
      sample_rate: String(this.opts.sampleRate ?? 16000),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: "300",
      vad_events: "true",
      diarize: "true"
    })
    const base = relayWsUrl(this.opts.relayUrl ?? process.env.IGPT_RELAY_URL ?? undefined)
    const ws = new WebSocket(`${base}/v1/listen?${params}`, {
      headers: { Authorization: `Bearer ${APP_TOKEN}`, "X-Device-Id": this.opts.deviceId }
    })
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Deepgram connection timed out"))
        ws.terminate()
      }, OPEN_TIMEOUT_MS)

      ws.once("open", () => {
        clearTimeout(timer)
        this.startKeepAlive()
        this.emit("open")
        resolve()
      })
      ws.on("message", (data) => {
        const event = parseDeepgramMessage(data.toString())
        if (event) this.emit("transcript", event)
      })
      ws.on("error", (err) => {
        clearTimeout(timer)
        this.emit("error", describeSocketError(err))
        reject(err)
      })
      ws.on("close", (code, reason) => {
        clearTimeout(timer)
        this.stopKeepAlive()
        this.emit("close", code, reason.toString(), this.closedByUs)
      })
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer)
        const err = new Error(
          res.statusCode === 401
            ? "This build of Meetingly is no longer accepted by the server. Please update the app."
            : res.statusCode === 429
              ? "Daily transcription limit reached. Try again tomorrow."
              : `Transcription server refused the connection (HTTP ${res.statusCode})`
        )
        this.emit("error", err)
        reject(err)
      })
    })
  }

  sendAudio(pcm16: Buffer | ArrayBuffer | Uint8Array): void {
    if (!this.isOpen) return
    const buffer = Buffer.isBuffer(pcm16) ? pcm16 : Buffer.from(pcm16 instanceof Uint8Array ? pcm16 : new Uint8Array(pcm16))
    this.ws!.send(buffer)
  }

  close(): void {
    this.closedByUs = true
    this.stopKeepAlive()
    const ws = this.ws
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }))
      } catch {
        /* socket already going away */
      }
      setTimeout(() => ws.terminate(), 500)
    } else {
      ws.terminate()
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAlive = setInterval(() => {
      if (this.isOpen) this.ws!.send(JSON.stringify({ type: "KeepAlive" }))
    }, KEEP_ALIVE_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }
}

/** Extract a transcript event from a Deepgram `Results` message (relayed verbatim). */
export function parseDeepgramMessage(raw: string): TranscriptEvent | null {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (msg?.type !== "Results") return null
  const alt = msg.channel?.alternatives?.[0]
  const text = typeof alt?.transcript === "string" ? alt.transcript.trim() : ""
  if (!text) return null
  const firstSpeaker = alt.words?.find((w: { speaker?: number }) => typeof w.speaker === "number")?.speaker
  return {
    text,
    isFinal: Boolean(msg.is_final),
    speechFinal: Boolean(msg.speech_final),
    confidence: Number(alt.confidence ?? 0),
    speaker: typeof firstSpeaker === "number" ? firstSpeaker : null
  }
}

function describeSocketError(err: Error & { code?: string }): Error {
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"].includes(err.code ?? "")) {
    return new Error("Cannot reach the Meetingly server. Check your internet connection.")
  }
  return err
}
