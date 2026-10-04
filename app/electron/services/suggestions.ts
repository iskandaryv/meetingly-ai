import { EventEmitter } from "node:events"
import { QUICK_ACTIONS, type Suggestion, type SuggestionsState } from "../../shared/types"
import type { ChatService } from "./chat"
import { describeRelayError, type Llm, type LlmMessage } from "./llm"
import type { RecordingSession } from "./session"
import type { SettingsStore } from "./settings"
import { t } from "../../shared/i18n"

interface Deps {
  settings: Pick<SettingsStore, "get" | "activePrompt">
  llm: Pick<Llm, "chat" | "languageInstruction">
  session: Pick<RecordingSession, "transcriptText">
  chat: Pick<ChatService, "send" | "isBusy" | "getHistory">
}

const MAX_ITEMS = 4
const MAX_CHARS = 140
const TRANSCRIPT_IN_PROMPT = 3000
/** The model's running notes about the conversation, carried from run to run. */
const MAX_CONTEXT_CHARS = 500
/** A forced refresh with nothing new treats this much of the end as the newest part. */
const RECENT_CHARS = 600
/** Wait for a pause after an utterance, so a burst of them becomes one run. */
const DEBOUNCE_MS = 2000
const MIN_INTERVAL_MS = 20_000
/** New transcript text needed before asking again: the first run, then each later one. */
const FIRST_RUN_CHARS = 80
const GROWTH_CHARS = 120
/** After a failure (daily limit, network), wait this long before trying again on its own. */
const BACKOFF_MS = 60_000

const SUGGEST_PROMPT = `You help someone in a live conversation (a job interview, a sales call, a meeting) by suggesting questions for their AI assistant to answer right now. "Them" is the other side, "You" is the user. A click on a suggestion shows the AI's answer, so every suggestion is a question with a real answer. Do not suggest questions for the user to ask Them.

Suggest up to ${MAX_ITEMS}, most useful first, each at most 14 words and clear on its own:
1. If Them just asked the user something (not small talk), the first suggestion is that question, restated as a direct question with "it" or "that" spelled out.
2. A term, technology, name or number that just came up: "What is ...?", "How does ... work?".
3. The question Them is most likely to ask next, so its answer is ready.

Ask the question itself. Never coach: no "How should I explain ...", "What should I mention ...", "How can I describe ...".
Work from the NEW part of the transcript. Repeat an earlier suggestion only while its topic is still being discussed, and never suggest something already answered on screen.

Also return:
- "topic": what is being discussed right now, at most 6 words.
- "context": at most 60 words of lasting facts: who Them is, their company and product, the role or deal, what the user said about themselves, topics already covered. Update the previous context; keep every fact that still matters.

Reply with JSON only: {"topic": "...", "context": "...", "questions": ["...", "..."]}`

/**
 * The suggestions rail: while listening, reads the transcript every so often and offers
 * questions to ask the AI with one click, plus fixed quick actions. Never blocks chat.
 *
 * Events: "state" (SuggestionsState)
 */
export class SuggestionService extends EventEmitter {
  private topic = ""
  /** Lasting facts the model keeps about the conversation, so the start of a long one is not lost. */
  private context = ""
  private items: Suggestion[] = []
  /** Questions already asked this session; never offered again. */
  private used = new Set<string>()
  private updating = false
  /** An utterance arrived while a run was in flight: check again after it. */
  private again = false
  private timer: NodeJS.Timeout | null = null
  private lastRunAt = 0
  /** Transcript length at the last run. */
  private seenChars = 0
  private failedAt = 0
  /** Bumped by reset(), so a reply that lands after the session ended is dropped. */
  private generation = 0

  constructor(private readonly deps: Deps) {
    super()
  }

  state(): SuggestionsState {
    return { topic: this.topic, items: [...this.items], updating: this.updating }
  }

  /** A finished utterance from either side. */
  onUtterance(): void {
    if (!this.enabled()) return
    if (this.updating) this.again = true
    else this.schedule(DEBOUNCE_MS)
  }

  /** The refresh button: ask now, whatever the interval. */
  async refresh(): Promise<void> {
    this.cancelTimer()
    await this.run(true)
  }

  /** The session ended: forget everything. */
  reset(): void {
    this.cancelTimer()
    if (!this.topic && this.items.length === 0 && !this.updating && this.seenChars === 0) return
    this.generation++
    this.topic = ""
    this.context = ""
    this.items = []
    this.used.clear()
    this.updating = false
    this.again = false
    this.lastRunAt = 0
    this.seenChars = 0
    this.failedAt = 0
    this.emitState()
  }

  /** Ask a suggestion or a quick action; the answer streams into chat. False when chat is busy. */
  use(id: string): boolean {
    if (this.deps.chat.isBusy) return false
    const action = QUICK_ACTIONS.find((a) => a.id === id)
    if (action) {
      void this.deps.chat.send(t(action.label), { prompt: action.prompt })
      return true
    }
    const item = this.items.find((s) => s.id === id)
    if (!item) return false
    this.used.add(key(item.text))
    this.items = this.items.filter((s) => s !== item)
    this.emitState()
    void this.deps.chat.send(item.text)
    return true
  }

  private enabled(): boolean {
    return this.deps.settings.get().suggestions !== false
  }

  private schedule(delay: number): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(false)
    }, delay)
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async run(force: boolean): Promise<void> {
    if (!this.enabled()) return
    if (this.updating) {
      this.again = true
      return
    }
    const transcript = this.deps.session.transcriptText()
    if (!transcript.trim()) return
    if (!force) {
      const grown = transcript.length - this.seenChars
      if (grown < (this.lastRunAt === 0 ? FIRST_RUN_CHARS : GROWTH_CHARS)) return
      const wait = Math.max(this.lastRunAt + MIN_INTERVAL_MS, this.failedAt + BACKOFF_MS) - Date.now()
      if (wait > 0) {
        this.schedule(wait)
        return
      }
    }

    const generation = this.generation
    const since = this.seenChars
    this.updating = true
    this.again = false
    this.lastRunAt = Date.now()
    this.seenChars = transcript.length
    this.emitState()
    try {
      const { text } = await this.deps.llm.chat(this.messages(transcript, since), undefined, "suggest")
      if (generation !== this.generation) return
      const parsed = parseSuggestions(text)
      if (parsed) {
        if (parsed.topic) this.topic = parsed.topic
        if (parsed.context) this.context = parsed.context
        this.items = mergeSuggestions(this.items, parsed.questions.filter((q) => !this.used.has(key(q))))
      } else {
        console.warn("[suggestions] unreadable reply:", text.slice(0, 160))
      }
      this.failedAt = 0
    } catch (err) {
      if (generation !== this.generation) return
      this.failedAt = Date.now()
      console.warn("[suggestions] failed:", describeRelayError(err))
    } finally {
      if (generation === this.generation) {
        this.updating = false
        this.emitState()
        if (this.again) {
          this.again = false
          this.schedule(DEBOUNCE_MS)
        }
      }
    }
  }

  /** `since`: transcript length at the previous run; what follows it is marked as new. */
  private messages(transcript: string, since: number): LlmMessage[] {
    const notes = this.deps.settings.activePrompt().notes?.trim()
    const system = [SUGGEST_PROMPT]
    if (notes) system.push(`Background about the user:\n${notes}`)
    system.push(`Write the topic, the context and the questions in the language this names: ${this.deps.llm.languageInstruction()}`)

    const window = transcript.slice(-TRANSCRIPT_IN_PROMPT)
    const offset = transcript.length - window.length
    const start = since < transcript.length ? since : transcript.length - RECENT_CHARS
    const split = Math.max(0, start - offset)
    const earlierText = window.slice(0, split).trim()
    const newText = window.slice(split).trim()
    const answered = this.deps.chat
      .getHistory()
      .filter((m) => m.role === "user")
      .slice(-4)
      .map((m) => `- ${m.text.slice(0, 160)}`)
    const parts = [
      `What you know so far: ${this.context || "(nothing yet)"}`,
      `Your earlier suggestions:\n${this.items.map((s) => `- ${s.text}`).join("\n") || "(none)"}`
    ]
    if (answered.length > 0) parts.push(`Already answered on screen:\n${answered.join("\n")}`)
    if (earlierText) parts.push(`Transcript, earlier part:\n${earlierText}`)
    parts.push(`Transcript, NEW since your last suggestions:\n${newText}`)
    return [
      { role: "system", content: system.join("\n\n") },
      { role: "user", content: parts.join("\n\n") }
    ]
  }

  private emitState(): void {
    this.emit("state", this.state())
  }
}

/** Read the model's JSON reply, tolerating code fences and prose around it. Null when unreadable. */
export function parseSuggestions(text: string): { topic: string; context: string; questions: string[] } | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let data: { topic?: unknown; context?: unknown; questions?: unknown }
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!data || !Array.isArray(data.questions)) return null
  const seen = new Set<string>()
  const questions: string[] = []
  for (const q of data.questions) {
    if (typeof q !== "string") continue
    const t = squash(q)
    if (!t || seen.has(key(t))) continue
    seen.add(key(t))
    questions.push(t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1)}…` : t)
    if (questions.length === MAX_ITEMS) break
  }
  const topic = typeof data.topic === "string" ? squash(data.topic).slice(0, 60) : ""
  const context = typeof data.context === "string" ? squash(data.context).slice(0, MAX_CONTEXT_CHARS) : ""
  return { topic, context, questions }
}

/** New list, keeping the id of every question that was already there so the rail does not flicker. */
export function mergeSuggestions(previous: Suggestion[], questions: string[]): Suggestion[] {
  const ids = new Map(previous.map((s) => [key(s.text), s.id]))
  return questions.map((text) => ({ id: ids.get(key(text)) ?? newId(), text }))
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function key(text: string): string {
  return squash(text).toLowerCase()
}

function newId(): string {
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}
