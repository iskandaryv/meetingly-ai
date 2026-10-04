import { EventEmitter } from "node:events"
import { ANSWER_FORMAT, ANSWER_LENGTHS, type ChatMessage, type Prompt, type ScreenshotResult, type Settings, type Utterance } from "../../shared/types"
import type { Capture } from "./capture"
import { describeRelayError, type Llm, type LlmMessage } from "./llm"
import type { RecordingSession } from "./session"
import type { SettingsStore } from "./settings"
import { t } from "../../shared/i18n"

interface Deps {
  settings: SettingsStore
  llm: Llm
  session: RecordingSession
  capture: () => Promise<Capture>
  /** Hide / restore the app's own windows around a capture when they are not content-protected. */
  hideForCapture?: () => () => void
}

const MAX_HISTORY = 40
const HISTORY_IN_PROMPT = 12
const TRANSCRIPT_IN_PROMPT = 4000
/** Utterances shorter than this (letters and digits) are never sent: "ok", "да", "yeah". */
const AUTO_ANSWER_MIN_LETTERS = 4

const SCREENSHOT_PROMPT =
  "This is the user's current screen. Describe what matters and help with it: if it shows a question or a task, " +
  "answer or solve it directly; if it shows code, explain or fix it; otherwise summarize what is on screen briefly."

/**
 * Conversation state lives here, in the main process, so every window sees
 * the same history and the LLM context is assembled in one place.
 *
 * Events: "message" (ChatMessage), "chunk" ({id,text}), "busy" (boolean), "cleared", "auto-answer" (ChatMessage)
 */
export class ChatService extends EventEmitter {
  private history: ChatMessage[] = []
  /** A visible reply or screen analysis is in flight: the UI shows it and user actions wait for it. */
  private busy = false
  /** An auto-answer check still deciding whether to answer. Invisible; a user action cancels it. */
  private probe: { superseded: boolean } | null = null
  private draining = false
  /** Utterances waiting to be checked; joined, so a question split by a pause stays whole. */
  private queued: string | null = null

  constructor(private readonly deps: Deps) {
    super()
  }

  /** A visible reply or screen analysis is running; new asks are ignored until it ends. */
  get isBusy(): boolean {
    return this.busy
  }

  getHistory(): ChatMessage[] {
    return [...this.history]
  }

  clear(): void {
    this.history = []
    this.emit("cleared")
  }

  /** `prompt`, when given, is what the model gets while chat shows `text` (quick actions). */
  async send(text: string, opts: { prompt?: string } = {}): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || this.busy) return
    this.supersedeProbe()
    this.push({ role: "user", kind: "text", text: trimmed })
    await this.reply(opts.prompt?.trim() || trimmed, "text")
    this.drainSoon()
  }

  /**
   * Hands-free answering, called for every finished utterance while listening. The model
   * decides whether it calls for an answer ("questions" mode) and answers in the same call;
   * when it does not, nothing appears in chat. "always" answers every utterance. The user's
   * own speech (microphone channel) is context only and never answered.
   */
  async autoAnswer(utterance: Utterance): Promise<void> {
    if (this.deps.settings.get().autoAnswer === "off") return
    if (utterance.channel === "you") return
    const text = utterance.text.trim()
    if (letterCount(text) < AUTO_ANSWER_MIN_LETTERS) return
    this.queued = this.queued ? `${this.queued} ${text}` : text
    await this.drain()
  }

  /** "Answer now": the last thing heard, always answered. */
  async answerLast(): Promise<boolean> {
    const last = this.deps.session.getLastUtterance()
    if (!last || this.busy) return false
    this.supersedeProbe()
    await this.answerUtterance(last.text.trim(), false)
    this.drainSoon()
    return true
  }

  async screenshot(prompt?: string): Promise<ScreenshotResult> {
    if (this.busy) throw new Error(t("Wait for the current answer to finish."))
    this.supersedeProbe()
    this.setBusy(true)
    const restore = this.deps.hideForCapture?.()
    try {
      const shot = await this.deps.capture()
      restore?.()
      const { text, tokens } = await this.deps.llm.vision(shot.base64, prompt?.trim() || SCREENSHOT_PROMPT, this.systemPrompt())
      this.push({ role: "assistant", kind: "screenshot", text: text || t("(no description)") })
      return { text, tokens, dimensions: `${shot.width}x${shot.height}` }
    } catch (err) {
      restore?.()
      this.push({ role: "assistant", kind: "error", text: errorText(err) })
      throw err
    } finally {
      this.setBusy(false)
      this.drainSoon()
    }
  }

  /** Check queued utterances one at a time; pauses while a visible reply runs. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queued && !this.busy) {
        const next = this.queued
        this.queued = null
        const mode = this.deps.settings.get().autoAnswer
        if (mode === "off") break
        await this.answerUtterance(next, mode === "questions")
      }
    } finally {
      this.draining = false
    }
  }

  private drainSoon(): void {
    if (this.queued) void this.drain()
  }

  /** A user action wins over an undecided auto-answer check: its result is discarded. */
  private supersedeProbe(): void {
    if (this.probe) this.probe.superseded = true
    this.probe = null
  }

  private async answerUtterance(text: string, mayDecline: boolean): Promise<void> {
    const answer = "answer it directly: give the answer itself, ready to say out loud, never advice about how to answer"
    const ask = mayDecline
      ? `Heard in the meeting: "${text}"\n\nIf this asks the user something or calls for a reply from them (a question, a request, a task, in any language), ${answer}. If it does not (small talk, a plain statement), reply with exactly ${SKIP_TOKEN} and nothing else.`
      : `Heard in the meeting: "${text}"\n\nThe user wants an answer to this: ${answer}.`
    const message = await this.reply(ask, "auto", { heard: text, gate: mayDecline })
    if (message) this.emit("auto-answer", message)
  }

  /**
   * One LLM turn. For an auto-answer, `heard` is pushed to the conversation only once the
   * reply commits to answering; with `gate`, the start of the stream is held back until it
   * is clear whether the model answered or returned SKIP_TOKEN, so a skip shows nothing at all.
   */
  private async reply(userContent: string, kind: "text" | "auto", opts: { heard?: string; gate?: boolean } = {}): Promise<ChatMessage | null> {
    // send() has already pushed the user's message; an auto-answer has not pushed anything yet.
    const history = opts.heard === undefined ? this.history.slice(0, -1) : this.history
    const messages = buildMessages({ system: this.systemPrompt(), history, transcript: this.deps.session.transcriptText() })
    messages.push({ role: "user", content: userContent })

    const id = newId()
    const probe = opts.gate ? { superseded: false } : null
    if (probe) this.probe = probe
    let state: "wait" | "skip" | "answer" = probe ? "wait" : "answer"
    let committed = false
    let head = ""
    /** Become visible: show what was heard and mark chat busy. Refused if a user action took over. */
    const commit = (): boolean => {
      if (probe) {
        if (probe.superseded || this.busy) return false
        this.probe = null
      }
      if (opts.heard !== undefined) this.push({ role: "user", kind: "auto", text: opts.heard })
      this.setBusy(true)
      committed = true
      return true
    }
    if (!probe) commit()
    try {
      const { text: reply } = await this.deps.llm.chat(messages, (delta) => {
        if (state === "skip") return
        if (state === "wait") {
          head += delta
          const decision = gateDecision(head)
          if (decision === "wait") return
          state = decision === "answer" && commit() ? "answer" : "skip"
          if (state === "answer") this.emit("chunk", { id, text: head })
          return
        }
        this.emit("chunk", { id, text: delta })
      }, probe ? "auto" : "answer")
      // `state` is changed inside the stream callback, which TypeScript's narrowing cannot see.
      const outcome = state as "wait" | "skip" | "answer"
      if (outcome !== "answer") {
        if (outcome === "skip" || gateDecision(reply ?? "") !== "answer" || !commit()) {
          if (!probe?.superseded) console.info("[auto-answer] no answer needed:", (opts.heard ?? "").slice(0, 120))
          return null
        }
      }
      return this.push({ id, role: "assistant", kind, text: reply || t("(empty reply)") })
    } catch (err) {
      if (committed) this.push({ id, role: "assistant", kind: "error", text: errorText(err) })
      else console.warn("[auto-answer] failed:", errorText(err))
      return null
    } finally {
      if (probe && this.probe === probe) this.probe = null
      if (committed) this.setBusy(false)
    }
  }

  private systemPrompt(): string {
    return composeSystemPrompt(this.deps.settings.activePrompt(), this.deps.settings.get(), this.deps.llm.languageInstruction())
  }

  private push(partial: Omit<ChatMessage, "id" | "timestamp"> & { id?: string }): ChatMessage {
    const message: ChatMessage = { id: partial.id ?? newId(), timestamp: Date.now(), ...partial }
    this.history.push(message)
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY)
    this.emit("message", message)
    return message
  }

  private setBusy(value: boolean): void {
    this.busy = value
    this.emit("busy", value)
  }
}

export interface PromptParts {
  system: string
  history: ChatMessage[]
  transcript: string
}

/** The active prompt plus the user's background notes, the answer layout and length, and the language. */
export function composeSystemPrompt(prompt: Prompt, settings: Pick<Settings, "answerLength">, languageInstruction: string): string {
  const parts = [prompt.content.trim()]
  const notes = prompt.notes?.trim()
  if (notes) parts.push(`Background about the user, use it whenever relevant:\n${notes}`)
  parts.push(ANSWER_FORMAT)
  parts.push(ANSWER_LENGTHS[settings.answerLength]?.instruction ?? ANSWER_LENGTHS.auto.instruction)
  parts.push(languageInstruction)
  return parts.join("\n\n")
}

/** Assemble the LLM message list: system prompt, live-meeting context, recent history. */
export function buildMessages(parts: PromptParts): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: parts.system }]

  const transcript = parts.transcript.trim()
  if (transcript) {
    messages.push({
      role: "system",
      content:
        "Live transcript of the meeting the user is in right now (most recent last). Use it as context when relevant:\n" +
        transcript.slice(-TRANSCRIPT_IN_PROMPT)
    })
  }

  for (const m of parts.history.slice(-HISTORY_IN_PROMPT)) {
    if (m.kind === "error") continue
    let content = m.text
    if (m.kind === "screenshot") content = `[Screenshot analysis]\n${m.text}`
    if (m.kind === "auto" && m.role === "user") content = `[Heard in the meeting] ${m.text}`
    messages.push({ role: m.role, content })
  }
  return messages
}

/**
 * What the model replies, alone, when what it heard needs no answer. The model decides in
 * any language; word lists of question openers were English-only and missed most questions.
 */
export const SKIP_TOKEN = "[no-answer]"

/**
 * Gate on the start of a streamed reply: still undecided, the skip marker, or a real answer.
 * Answers open with a bold sentence, so leading markdown is ignored: "**[no-answer]**" is a skip too.
 */
export function gateDecision(soFar: string): "wait" | "skip" | "answer" {
  const t = soFar.replace(/^[\s*_`]+/, "")
  if (!t) return "wait"
  if (t.startsWith(SKIP_TOKEN)) return "skip"
  if (SKIP_TOKEN.startsWith(t)) return "wait"
  return "answer"
}

function letterCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

function errorText(err: unknown): string {
  return describeRelayError(err)
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}
