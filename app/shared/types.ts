// Types shared by the Electron main process and the renderer.

/** The toolbar and the attached panel (answers + live transcript). Everything else is on the web dashboard. */
export type WindowKind = "main" | "chat"

/** Tabs of the attached panel (window kind "chat"). */
export type PanelTab = "answers" | "transcript"

export type LanguageCode = "en" | "ar" | "bg" | "zh" | "hr" | "cs" | "da" | "nl" | "et" | "fi" | "fr" | "de" | "hi" | "hu" | "it" | "ja" | "ko" | "no" | "pl" | "pt" | "ro" | "ru" | "sk" | "es" | "sv" | "tr" | "uk" | "vi"

export interface Language {
  code: LanguageCode
  name: string
  /** Deepgram `language` parameter (cloud transcription). */
  deepgram: string
  /** Nemotron 3.5 locale (on-device transcription). All 32 production locales are covered by these 28 languages. */
  asr: string
  /** Instruction appended to LLM prompts. */
  instruction: string
}

/** English first, then alphabetical. */
export const LANGUAGES: Language[] = [
  { code: "en", name: "English", deepgram: "en", asr: "en-US", instruction: "Respond in English." },
  { code: "ar", name: "Arabic (العربية)", deepgram: "ar", asr: "ar-AR", instruction: "Respond in Arabic (العربية)." },
  { code: "bg", name: "Bulgarian (Български)", deepgram: "bg", asr: "bg-BG", instruction: "Respond in Bulgarian (Български)." },
  { code: "zh", name: "Chinese (中文)", deepgram: "zh", asr: "zh-CN", instruction: "Respond in Chinese (中文)." },
  { code: "hr", name: "Croatian (Hrvatski)", deepgram: "hr", asr: "hr-HR", instruction: "Respond in Croatian (Hrvatski)." },
  { code: "cs", name: "Czech (Čeština)", deepgram: "cs", asr: "cs-CZ", instruction: "Respond in Czech (Čeština)." },
  { code: "da", name: "Danish (Dansk)", deepgram: "da", asr: "da-DK", instruction: "Respond in Danish (Dansk)." },
  { code: "nl", name: "Dutch (Nederlands)", deepgram: "nl", asr: "nl-NL", instruction: "Respond in Dutch (Nederlands)." },
  { code: "et", name: "Estonian (Eesti)", deepgram: "et", asr: "et-EE", instruction: "Respond in Estonian (Eesti)." },
  { code: "fi", name: "Finnish (Suomi)", deepgram: "fi", asr: "fi-FI", instruction: "Respond in Finnish (Suomi)." },
  { code: "fr", name: "French (Français)", deepgram: "fr", asr: "fr-FR", instruction: "Respond in French (Français)." },
  { code: "de", name: "German (Deutsch)", deepgram: "de", asr: "de-DE", instruction: "Respond in German (Deutsch)." },
  { code: "hi", name: "Hindi (हिन्दी)", deepgram: "hi", asr: "hi-IN", instruction: "Respond in Hindi (हिन्दी)." },
  { code: "hu", name: "Hungarian (Magyar)", deepgram: "hu", asr: "hu-HU", instruction: "Respond in Hungarian (Magyar)." },
  { code: "it", name: "Italian (Italiano)", deepgram: "it", asr: "it-IT", instruction: "Respond in Italian (Italiano)." },
  { code: "ja", name: "Japanese (日本語)", deepgram: "ja", asr: "ja-JP", instruction: "Respond in Japanese (日本語)." },
  { code: "ko", name: "Korean (한국어)", deepgram: "ko", asr: "ko-KR", instruction: "Respond in Korean (한국어)." },
  { code: "no", name: "Norwegian (Norsk)", deepgram: "no", asr: "nb-NO", instruction: "Respond in Norwegian Bokmål (Norsk)." },
  { code: "pl", name: "Polish (Polski)", deepgram: "pl", asr: "pl-PL", instruction: "Respond in Polish (Polski)." },
  { code: "pt", name: "Portuguese (Português)", deepgram: "pt", asr: "pt-BR", instruction: "Respond in Portuguese (Português)." },
  { code: "ro", name: "Romanian (Română)", deepgram: "ro", asr: "ro-RO", instruction: "Respond in Romanian (Română)." },
  { code: "ru", name: "Russian (Русский)", deepgram: "ru", asr: "ru-RU", instruction: "Respond in Russian (Русский язык)." },
  { code: "sk", name: "Slovak (Slovenčina)", deepgram: "sk", asr: "sk-SK", instruction: "Respond in Slovak (Slovenčina)." },
  { code: "es", name: "Spanish (Español)", deepgram: "es", asr: "es-US", instruction: "Respond in Spanish (Español)." },
  { code: "sv", name: "Swedish (Svenska)", deepgram: "sv", asr: "sv-SE", instruction: "Respond in Swedish (Svenska)." },
  { code: "tr", name: "Turkish (Türkçe)", deepgram: "tr", asr: "tr-TR", instruction: "Respond in Turkish (Türkçe)." },
  { code: "uk", name: "Ukrainian (Українська)", deepgram: "uk", asr: "uk-UA", instruction: "Respond in Ukrainian (Українська)." },
  { code: "vi", name: "Vietnamese (Tiếng Việt)", deepgram: "vi", asr: "vi-VN", instruction: "Respond in Vietnamese (Tiếng Việt)." }
]

export function getLanguage(code: string): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]
}

/**
 * "microphone" also covers virtual devices (BlackHole, PulseAudio monitors) picked by id.
 * "system" is what the user hears (the other side of the call). "both" mixes the two.
 */
export type AudioSource = "microphone" | "system" | "both"

export const AUDIO_SOURCE_LABELS: Record<AudioSource, string> = {
  both: "Microphone + system audio",
  system: "System audio only",
  microphone: "Microphone only"
}

/** Where speech is turned into text: on this computer (NVIDIA Nemotron) or in the cloud (Deepgram). */
export type TranscriptionEngine = "local" | "cloud"

export const TRANSCRIPTION_ENGINE_LABELS: Record<TranscriptionEngine, string> = {
  local: "On this computer (private, free)",
  cloud: "Cloud (Unlimited plan)"
}

export type AutoAnswerMode = "off" | "questions" | "always"

export const AUTO_ANSWER_LABELS: Record<AutoAnswerMode, string> = {
  off: "Off",
  questions: "When a question is asked",
  always: "After every pause"
}

export type AnswerLength = "short" | "medium" | "auto"

/** How every answer is laid out, whatever the prompt: readable at a glance while speaking. */
export const ANSWER_FORMAT =
  "Lay out every answer to be read at a glance while speaking: first the answer itself as one bold sentence, then 2 to 4 catch points as bullets the user can expand on out loud, each a fragment of 3 to 8 words, not a sentence. No headings."

export const ANSWER_LENGTHS: Record<AnswerLength, { label: string; instruction: string }> = {
  short: {
    label: "Short",
    instruction: "Stop after the catch points."
  },
  medium: {
    label: "Medium",
    instruction: "After the catch points, add one short paragraph with the key details."
  },
  auto: {
    label: "Automatic",
    instruction: "Usually stop after the catch points; add code or a few steps after them only when the question needs it."
  }
}

export interface Prompt {
  id: string
  title: string
  content: string
  /** Background the assistant should know (CV, job description, product facts). */
  notes?: string
}

export type ShortcutAction =
  | "showToolbar"
  | "toggleAll"
  | "listen"
  | "chat"
  | "screenshot"
  | "dashboard"
  | "moveLeft"
  | "moveRight"
  | "moveUp"
  | "moveDown"

export type Shortcuts = Record<ShortcutAction, string>

/**
 * Plain Ctrl/Cmd chords where they're free (owner's decision). Global shortcuts take the key from every
 * other app while Meetingly runs, so Toggle chat is Ctrl+Shift+C rather than Ctrl+C (which must keep
 * copying everywhere); Ctrl+arrows no longer jump by word elsewhere. Users rebind them on the web dashboard.
 */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  showToolbar: "CommandOrControl+Space",
  toggleAll: "CommandOrControl+B",
  listen: "CommandOrControl+L",
  chat: "CommandOrControl+Shift+C",
  screenshot: "CommandOrControl+Enter",
  dashboard: "CommandOrControl+D",
  moveLeft: "CommandOrControl+Left",
  moveRight: "CommandOrControl+Right",
  moveUp: "CommandOrControl+Up",
  moveDown: "CommandOrControl+Down"
}

/** Defaults before the switch to plain Ctrl chords; saved values still equal to these are migrated. */
export const LEGACY_DEFAULT_SHORTCUTS: Shortcuts = {
  showToolbar: "CommandOrControl+Alt+Space",
  toggleAll: "CommandOrControl+Alt+B",
  listen: "CommandOrControl+Alt+L",
  chat: "CommandOrControl+Alt+C",
  screenshot: "CommandOrControl+Alt+Enter",
  dashboard: "CommandOrControl+Alt+D",
  moveLeft: "CommandOrControl+Alt+Left",
  moveRight: "CommandOrControl+Alt+Right",
  moveUp: "CommandOrControl+Alt+Up",
  moveDown: "CommandOrControl+Alt+Down"
}

/** Later defaults that were replaced; a saved value still equal to one of these follows the current default. */
export const RETIRED_DEFAULT_SHORTCUTS: Partial<Shortcuts> = {
  chat: "CommandOrControl+C"
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  showToolbar: "Show and center the toolbar",
  toggleAll: "Hide / show all windows",
  listen: "Start / pause / resume listening",
  chat: "Toggle chat",
  screenshot: "Analyze the screen in chat",
  dashboard: "Open the web dashboard",
  moveLeft: "Move toolbar left",
  moveRight: "Move toolbar right",
  moveUp: "Move toolbar up",
  moveDown: "Move toolbar down"
}

export interface Settings {
  /** Random id created on first run; identifies this install to the relay for quotas. */
  deviceId: string
  outputLanguage: LanguageCode
  audioLanguage: LanguageCode
  audioSource: AudioSource
  transcriptionEngine: TranscriptionEngine
  /** Input device id for "microphone"; empty = system default. */
  audioDeviceId: string
  autoAnswer: AutoAnswerMode
  answerLength: AnswerLength
  /** Show suggested questions on the left of the panel while listening. */
  suggestions: boolean
  stealth: boolean
  autoLaunch: boolean
  prompts: Prompt[]
  activePromptId: string | null
  shortcuts: Shortcuts
  /** Linked account for sync; null when the app runs standalone. */
  cloud: import("./cloud").CloudAccount | null
  /** The user's own OpenAI-compatible endpoint; when set, AI requests go there instead of the relay. Never synced. */
  ownKey: OwnKey | null
}

export interface OwnKey {
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1. */
  baseUrl: string
  model: string
  /** Encrypted at rest when the OS keychain is available; empty for endpoints without keys (Ollama). */
  key: string
}

/** What the renderer sees: never the key itself, only whether one is saved. */
export interface OwnKeyView {
  baseUrl: string
  model: string
  hasKey: boolean
}

/** What the own-key form sends. An empty key keeps the saved one (editing only the model), or means none (Ollama). */
export interface OwnKeyInput {
  baseUrl: string
  key: string
  model?: string
}

/** One-click endpoints in the own-key form. Ollama runs models on this computer and needs no key. */
export const OWN_KEY_PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" }
] as const

export const DEFAULT_SYSTEM_PROMPT = `You are a real-time assistant for meetings and interviews. Give the actual answer to what was asked, the way a knowledgeable person would say it out loud.

- Answer the question itself. Never coach or describe how to answer.
- If the question is about the user, answer in the first person as the user, from their background and what they said earlier. Put a short [placeholder] for a personal detail you don't know.
- No preamble, filler or closing question. Spoken language with contractions.
- For code, give the code with brief comments.
- If the question is ambiguous, answer the most likely meaning.`

/** Earlier defaults; a saved prompt still identical to one of them is upgraded on load. */
export const LEGACY_DEFAULT_SYSTEM_PROMPTS = [
  // Until 2026-10-04. It told the model never to give a script, so answers came out as coaching.
  `You are a real-time assistant that gives the user information during meetings and other workflows. Answer the user's query directly.

Responses must be short and terse:
- Aim for 1-2 sentences; if longer, use bullet points for structure
- Get straight to the point and never add filler, preamble, or meta-comments
- Never give the user a direct script to say; responses must be informative
- Do not end with a question or prompt to the user
- If an example is needed, give one specific example without inventing details
- If a response calls for code, write all code required with brief comments

Tone must be natural, human, and conversational:
- Never be robotic or overly formal
- Use contractions naturally
- Avoid unnecessary adjectives or dramatic emphasis`,
  // 2026-10-04. Longer, with a stack-specific example.
  `You are a real-time assistant for meetings and interviews. When a question comes up, give the actual answer, the way a knowledgeable person would say it out loud.

- Answer the question itself. Asked "What is Kafka?", explain what Kafka is. Never coach: no "mention...", "say that...", "you could talk about...", and never describe how to answer.
- When the question is about the user (their experience, opinions, plans), answer in the first person as the user, using their background when it is given.
- Put the answer in the first sentence, then the key details. No preamble, no filler, no closing question.
- Use plain spoken language with contractions. Bullet points only when the answer really is a list.
- For a coding question, give the code with brief comments.
- If the question is ambiguous, answer the most likely meaning.`,
  // 2026-10-04, later. Before answers were laid out as catch points.
  `You are a real-time assistant for meetings and interviews. Give the actual answer to what was asked, the way a knowledgeable person would say it out loud.

- Answer the question itself. Never coach or describe how to answer.
- If the question is about the user, answer in the first person as the user, from their background and what they said earlier. Put a short [placeholder] for a personal detail you don't know.
- Lead with the answer, then the key details. No preamble, filler or closing question.
- Spoken language with contractions. Bullets only for real lists; code with brief comments.
- If the question is ambiguous, answer the most likely meaning.`
]

export const DEFAULT_PROMPT: Prompt = {
  id: "default",
  title: "Meeting assistant",
  content: DEFAULT_SYSTEM_PROMPT,
  notes: ""
}

export const DEFAULT_SETTINGS: Settings = {
  deviceId: "",
  outputLanguage: "en",
  audioLanguage: "en",
  audioSource: "both",
  transcriptionEngine: "local",
  audioDeviceId: "",
  autoAnswer: "questions",
  answerLength: "auto",
  suggestions: true,
  stealth: true,
  autoLaunch: false,
  prompts: [DEFAULT_PROMPT],
  activePromptId: DEFAULT_PROMPT.id,
  shortcuts: DEFAULT_SHORTCUTS,
  cloud: null,
  ownKey: null
}

/** Settings as seen by the renderer, plus resolved facts about the environment. */
export interface SettingsView extends Omit<Settings, "ownKey"> {
  ownKey: OwnKeyView | null
  version: string
  platform: string
  /** The interface language in use: the system language when Meetingly speaks it, else English. */
  uiLocale: LanguageCode
  /** Shortcuts that could not be registered because another app owns them. */
  shortcutConflicts: ShortcutAction[]
}

export type SessionStatus = "idle" | "connecting" | "recording" | "paused"

export interface SessionState {
  status: SessionStatus
  startedAt: number | null
  /** Non-fatal problem worth showing (connection lost, reconnecting...). */
  notice: string | null
  /** True when the transcription socket is open. */
  connected: boolean
  audioSource: AudioSource
  audioDeviceId: string
}

/**
 * Who said it, from the audio channel: "you" is the microphone, "them" is system audio
 * (the other side of the call). Known when the two are transcribed separately (on-device).
 */
export type Channel = "you" | "them"

export interface TranscriptSegment {
  text: string
  timestamp: number
  confidence: number
  /** Diarized speaker index (0-based) when known. */
  speaker: number | null
  channel?: Channel | null
}

export interface TranscriptEvent {
  text: string
  isFinal: boolean
  /** The engine detected the end of an utterance (a pause). */
  speechFinal: boolean
  confidence: number
  speaker: number | null
  channel?: Channel | null
}

/** One finished utterance, the unit hands-free answering works on. */
export interface Utterance {
  text: string
  speaker: number | null
  channel?: Channel | null
  timestamp: number
}

export type ChatRole = "user" | "assistant"
/** "auto" marks turns produced by hands-free answering (the question heard, then the reply). */
export type ChatKind = "text" | "screenshot" | "error" | "auto"

export interface ChatMessage {
  id: string
  role: ChatRole
  kind: ChatKind
  text: string
  timestamp: number
}

export interface ChatChunk {
  id: string
  text: string
}

/** A question the suggestions rail offers, drawn from the live conversation. */
export interface Suggestion {
  id: string
  text: string
}

export interface SuggestionsState {
  /** What the conversation is about right now, a few words; empty until the first run. */
  topic: string
  items: Suggestion[]
  /** A refresh is in flight. */
  updating: boolean
}

export type QuickActionId = "say" | "ask" | "recap"

/** Fixed one-click asks under the suggestions: chat shows `label`, the model gets `prompt`. */
export const QUICK_ACTIONS: { id: QuickActionId; label: string; prompt: string }[] = [
  {
    id: "say",
    label: "What should I say?",
    prompt: "Based on the conversation so far, what should I say next? Give the exact words to say, ready to say out loud, not advice about what to say."
  },
  {
    id: "ask",
    label: "Questions to ask",
    prompt: "Suggest three sharp questions I could ask the other side right now, specific to this conversation."
  },
  {
    id: "recap",
    label: "Recap so far",
    prompt: "Recap the conversation so far: what was discussed, what was decided, what is still open."
  }
]

/** The rail shows, and the panel is widened for it, only during a session with suggestions on. */
export function suggestionsVisible(settings: Pick<Settings, "suggestions"> | null, status: SessionStatus): boolean {
  return Boolean(settings?.suggestions) && status !== "idle"
}

export interface MeetingSummary {
  title: string
  overview: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
  nextSteps: string[]
  followUpQuestions: string[]
  topics: string[]
  generatedAt: number
  language: LanguageCode
}

export type MeetingStatus = "processing" | "completed" | "failed"

export interface Meeting {
  id: string
  /** Record id on the account service once uploaded. */
  remoteId?: string
  title: string
  startTime: number
  endTime: number
  /** Milliseconds. */
  duration: number
  transcript: TranscriptSegment[]
  fullTranscriptText: string
  language: LanguageCode
  status: MeetingStatus
  summary?: MeetingSummary
  createdAt: number
  updatedAt: number
}

/** Plans the relay knows. "guest" is the allowance for builds from before accounts. */
export type PlanName = "guest" | "free" | "pro" | "unlimited"

export interface PlanUsage {
  answers: number
  vision: number
  listening: number
  reports: number
}

/** The account's plan and today's usage, as the relay counts it. */
export interface PlanState {
  /**
   * signed-out: no account linked (or its sign-in expired); offline: the relay could not be reached;
   * own-key: answers go to the user's own endpoint, so the relay's plan doesn't apply.
   */
  status: "unknown" | "signed-out" | "ok" | "offline" | "own-key"
  plan?: PlanName
  used?: PlanUsage
  limits?: PlanUsage
  /** When today's counts reset (midnight UTC). */
  resetAt?: string
}

/** What the updater is doing, for the toolbar: installing (the app restarts in a moment), or stuck. */
export interface UpdateState {
  status: "installing" | "needs-move"
  version?: string
}

export interface WindowsState {
  /** The attached panel is visible. */
  chat: boolean
  panelTab: PanelTab
}

export interface ScreenshotResult {
  text: string
  tokens: number
  dimensions: string
}

export function speakerLabel(speaker: number | null): string {
  return speaker === null ? "" : `Speaker ${speaker + 1}`
}

export const CHANNEL_LABELS: Record<Channel, string> = { you: "You", them: "Them" }

/** Label for a transcript line: You / Them when the channel is known, else the diarized speaker. */
export function segmentLabel(s: { speaker: number | null; channel?: Channel | null }): string {
  return s.channel ? CHANNEL_LABELS[s.channel] : speakerLabel(s.speaker)
}
