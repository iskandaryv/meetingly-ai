import { EventEmitter } from "node:events"
import { relayIdentity } from "./relayAuth"
import {
  getLanguage,
  segmentLabel,
  type Meeting,
  type SessionState,
  type SessionStatus,
  type TranscriptEvent,
  type TranscriptSegment,
  type Utterance
} from "../../shared/types"
import { DeepgramSocket } from "./deepgram"
import type { AsrModel } from "./asrModel"
import { LocalAsrSocket } from "./localAsr"
import type { MeetingStore } from "./meetings"
import type { ReportGenerator } from "./reports"
import type { SettingsStore } from "./settings"
import { t } from "../../shared/i18n"

interface Deps {
  settings: SettingsStore
  meetings: MeetingStore
  reports: ReportGenerator
  /** The on-device model; without it the session always uses the cloud. */
  asrModel?: AsrModel
  /** Whether the account's plan includes cloud transcription (Unlimited); otherwise the setting is ignored. */
  cloudTranscription?: () => boolean
  /** Injectable for tests. */
  createSocket?: (deviceId: string, language: string) => TranscriptionSocket
  /** A finished session was saved (main writes it as a text file); errors are the caller's to handle. */
  onFinished?: (meeting: Meeting) => void
  /** The user discarded the session (main deletes the transcript saved so far). */
  onDiscarded?: () => void
}

/** What the session needs from a transcription engine (Deepgram over the relay, or on-device Nemotron). */
export interface TranscriptionSocket extends EventEmitter {
  readonly isOpen: boolean
  /** Takes the capture's stereo stream (left = microphone, right = system audio) and transcribes each side. */
  readonly stereo?: boolean
  connect(): Promise<void>
  sendAudio(pcm16: ArrayBuffer): void
  close(): void
}

const MAX_RECONNECTS = 5
/** An utterance is also closed when the speaker keeps talking this long without a pause. */
const UTTERANCE_MAX_MS = 20000

/**
 * The one recording session. Owns the transcript, the transcription engine,
 * reconnection and utterance detection.
 *
 * Events: "state" (SessionState), "transcript" (TranscriptEvent), "utterance" (Utterance)
 */
export class RecordingSession extends EventEmitter {
  private status: SessionStatus = "idle"
  private startedAt: number | null = null
  private notice: string | null = null
  private socket: TranscriptionSocket | null = null
  private reconnects = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private segments: TranscriptSegment[] = []
  /** Finished segments not yet closed into an utterance, per speaker channel. */
  private pending = new Map<string, TranscriptSegment[]>()
  private lastUtterance: Utterance | null = null
  /** The meeting language and engine the current transcription engine was opened with (see syncEngine). */
  private engineKey = ""
  /** True while a transcription engine is starting. */
  private opening = false

  constructor(private readonly deps: Deps) {
    super()
  }

  state(): SessionState {
    const s = this.deps.settings.get()
    return {
      status: this.status,
      startedAt: this.startedAt,
      notice: this.notice,
      connected: this.socket?.isOpen ?? false,
      audioSource: s.audioSource,
      audioDeviceId: s.audioDeviceId
    }
  }

  /** Plain transcript with speaker labels when diarization produced any. */
  transcriptText(): string {
    return formatTranscript(this.segments)
  }

  getLastUtterance(): Utterance | null {
    return this.lastUtterance
  }

  async start(): Promise<SessionState> {
    if (this.status !== "idle") return this.state()
    this.segments = []
    this.pending.clear()
    this.lastUtterance = null
    this.reconnects = 0
    this.startedAt = Date.now()
    this.setStatus("connecting")
    try {
      await this.openSocket()
      this.setStatus("recording")
      // The meeting language may have changed while the engine started (the speech model downloads on first use).
      this.syncEngine()
    } catch (err) {
      this.socket = null
      this.startedAt = null
      this.setStatus("idle", (err as Error).message)
      throw err
    }
    return this.state()
  }

  pause(): SessionState {
    if (this.status === "recording") this.setStatus("paused")
    return this.state()
  }

  resume(): SessionState {
    if (this.status !== "paused") return this.state()
    if (!this.socket?.isOpen) {
      this.setStatus("connecting")
      this.openSocket()
        .then(() => {
          this.setStatus("recording")
          this.syncEngine()
        })
        .catch((err) => this.setStatus("idle", (err as Error).message))
    } else {
      this.setStatus("recording")
    }
    return this.state()
  }

  /** Capture delivers 16 kHz stereo PCM16: left = microphone (you), right = system audio (them). */
  sendAudio(pcm16: ArrayBuffer): void {
    if (this.status !== "recording" || !this.socket) return
    this.socket.sendAudio(this.socket.stereo ? pcm16 : downmix(pcm16))
  }

  /** Stop and save. Returns null when nothing was transcribed. */
  async finish(): Promise<Meeting | null> {
    if (this.status === "idle") return null
    const meeting = this.toMeeting(Date.now())
    this.teardown()
    this.setStatus("idle")

    if (!meeting) return null
    this.deps.meetings.save(meeting)
    this.deps.onFinished?.(meeting)
    // Report generation runs in the background; the meeting syncs to the web dashboard when it's done.
    void this.deps.reports.generate(meeting.id).catch((err) => console.error("[session] report failed:", err))
    return meeting
  }

  /** The session so far, saved nowhere: main writes it to the transcript file every minute. Null when idle or nothing was heard yet. */
  draft(): Meeting | null {
    return this.status === "idle" ? null : this.toMeeting(Date.now())
  }

  cancel(): SessionState {
    const active = this.status !== "idle"
    this.teardown()
    this.segments = []
    this.pending.clear()
    this.setStatus("idle")
    if (active) this.deps.onDiscarded?.()
    return this.state()
  }

  /**
   * Settings changed. When the meeting language (or the engine) is no longer the one the running engine was opened
   * with, it is reopened: the transcript so far stays, and only the moment the new engine takes to start goes unheard.
   */
  syncEngine(): void {
    if (this.status !== "recording" && this.status !== "paused") return
    if (this.opening || this.reconnectTimer || this.engineChoice().key === this.engineKey) return
    // Words heard in the old language don't start an utterance (and an auto-answer) together with the new ones.
    this.pending.clear()
    const opened = this.openSocket()
    const socket = this.socket
    opened.then(
      () => this.syncEngine(),
      (err) => {
        // Stopped, or replaced by another start (resume) in the meantime: nothing to recover.
        if (this.status === "idle" || this.socket !== socket) return
        console.warn("[session] could not switch the speech engine:", (err as Error).message)
        this.scheduleReconnect()
      }
    )
  }

  /** The transcript so far as a meeting; null when nothing was transcribed. */
  private toMeeting(endTime: number): Meeting | null {
    if (this.segments.length === 0) return null
    const startTime = this.startedAt ?? endTime
    const segments = [...this.segments]
    return {
      id: `meeting_${startTime}_${Math.random().toString(36).slice(2, 8)}`,
      title: titleFromTranscript(segments.map((s) => s.text).join(" ")),
      startTime,
      endTime,
      duration: endTime - startTime,
      transcript: segments,
      fullTranscriptText: formatTranscript(segments),
      language: this.deps.settings.get().audioLanguage,
      status: "processing",
      createdAt: endTime,
      updatedAt: endTime
    }
  }

  /** The engine and meeting language the settings ask for now. */
  private engineChoice() {
    const settings = this.deps.settings.get()
    const language = getLanguage(settings.audioLanguage)
    // Cloud transcription runs through Meetingly's server and is part of Unlimited: on any other plan (or with
    // only an own key) the session stays on this computer, whatever the setting says.
    const cloudAllowed = (this.deps.cloudTranscription?.() ?? true) && !(settings.ownKey !== null && !settings.cloud)
    const local = Boolean(this.deps.asrModel) && (settings.transcriptionEngine === "local" || !cloudAllowed)
    return { language, local, key: `${language.code}:${local ? "local" : "cloud"}` }
  }

  private async openSocket(): Promise<void> {
    this.socket?.removeAllListeners()
    this.socket?.close()
    const { language, local, key } = this.engineChoice()
    const deviceId = this.deps.settings.deviceId()
    const socket: TranscriptionSocket = this.deps.createSocket
      ? this.deps.createSocket(deviceId, language.deepgram)
      : local
        ? new LocalAsrSocket({ language: language.asr, model: this.deps.asrModel! })
        : new DeepgramSocket({ deviceId, language: language.deepgram, headers: relayIdentity(this.deps.settings) })
    this.socket = socket
    this.engineKey = key
    this.opening = true

    socket.on("transcript", (event: TranscriptEvent) => this.onTranscript(event))
    socket.on("error", (err: Error) => console.warn(local ? "[asr]" : "[deepgram]", err.message))
    socket.on("progress", (percent: number) => {
      this.notice = t("Downloading the speech model, {percent}%. This happens once.", { percent })
      this.emitState()
    })
    socket.on("close", (_code: number, _reason: string, byUs: boolean) => {
      if (byUs || this.status === "idle") return
      this.emitState()
      this.scheduleReconnect()
    })
    try {
      await socket.connect()
    } finally {
      if (this.socket === socket) this.opening = false
    }
    this.reconnects = 0
    this.notice = null
    this.emitState()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    if (this.reconnects >= MAX_RECONNECTS) {
      this.setStatus("paused", t("Connection lost. Press resume to reconnect."))
      return
    }
    this.reconnects += 1
    const delay = Math.min(30000, 1000 * 2 ** (this.reconnects - 1))
    this.notice = t("Connection lost, reconnecting ({n}/{max})…", { n: this.reconnects, max: MAX_RECONNECTS })
    this.emitState()
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.status === "idle") return
      try {
        await this.openSocket()
        this.syncEngine()
      } catch (err) {
        console.warn("[session] reconnect failed:", (err as Error).message)
        this.scheduleReconnect()
      }
    }, delay)
  }

  private onTranscript(event: TranscriptEvent): void {
    this.emit("transcript", event)
    if (!event.isFinal) return
    const segment: TranscriptSegment = {
      text: event.text,
      timestamp: Date.now(),
      confidence: event.confidence,
      speaker: event.speaker,
      channel: event.channel ?? null
    }
    this.segments.push(segment)
    const key = segment.channel ?? "all"
    const pending = this.pending.get(key) ?? []
    pending.push(segment)
    this.pending.set(key, pending)
    if (event.speechFinal || Date.now() - pending[0].timestamp > UTTERANCE_MAX_MS) this.closeUtterance(key)
  }

  private closeUtterance(key: string): void {
    const pending = this.pending.get(key)
    if (!pending || pending.length === 0) return
    const utterance: Utterance = {
      text: pending.map((s) => s.text).join(" "),
      speaker: pending[pending.length - 1].speaker,
      channel: pending[pending.length - 1].channel ?? null,
      timestamp: Date.now()
    }
    this.pending.delete(key)
    this.lastUtterance = utterance
    this.emit("utterance", utterance)
  }

  private teardown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.removeAllListeners()
    this.socket?.close()
    this.socket = null
    this.startedAt = null
    this.notice = null
  }

  private setStatus(status: SessionStatus, notice: string | null = null): void {
    this.status = status
    this.notice = notice
    this.emitState()
  }

  private emitState(): void {
    this.emit("state", this.state())
  }
}

/** Join segments, prefixing a speaker label (You / Them, or the diarized speaker) whenever it changes. */
export function formatTranscript(segments: TranscriptSegment[]): string {
  const labelled = segments.some((s) => s.channel || s.speaker !== null)
  if (!labelled) return segments.map((s) => s.text).join(" ")
  const lines: string[] = []
  let current: string | undefined
  for (const s of segments) {
    const label = segmentLabel(s) || "Unknown"
    if (label !== current) {
      current = label
      lines.push(`${label}: ${s.text}`)
    } else {
      lines[lines.length - 1] += ` ${s.text}`
    }
  }
  return lines.join("\n")
}

/** Stereo PCM16 (interleaved) to mono by averaging, for engines that take one stream (Deepgram). */
export function downmix(stereo: ArrayBuffer): ArrayBuffer {
  const input = new Int16Array(stereo, 0, (stereo.byteLength >> 2) << 1)
  const out = new Int16Array(input.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = (input[2 * i] + input[2 * i + 1]) >> 1
  return out.buffer
}

export function titleFromTranscript(text: string, fallback = t("Untitled meeting")): string {
  const clean = text.trim()
  if (!clean) return fallback
  const first = clean.split(/[.!?]/)[0].trim()
  if (first.length >= 6 && first.length <= 60) return first
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean
}
