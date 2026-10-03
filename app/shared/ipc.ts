// Single source of truth for IPC channel names and their signatures.
// The preload only forwards channels listed here; the renderer gets full typing.

import type { CloudState } from "./cloud"
import type {
  ChatChunk,
  ChatMessage,
  Meeting,
  ScreenshotResult,
  SessionState,
  Settings,
  SettingsView,
  SuggestionsState,
  TranscriptEvent,
  Utterance,
  WindowKind,
  WindowsState,
  PanelTab
} from "./types"

/** Renderer -> main request/response. */
export interface InvokeMap {
  "settings:get": () => SettingsView
  "settings:update": (patch: Partial<Settings>) => SettingsView

  "windows:state": () => WindowsState
  "windows:show": (kind: WindowKind) => void
  "windows:hide": (kind: WindowKind) => void
  "windows:toggle": (kind: WindowKind) => boolean
  "windows:toggle-all": () => void
  /** Show the panel on a tab; toggle hides it when it is already showing that tab. */
  "panel:show": (tab: PanelTab) => void
  "panel:toggle": (tab: PanelTab) => void
  /** The user switched tabs inside the panel. */
  "panel:set-tab": (tab: PanelTab) => void
  /** Resize the calling window to fit its content. */
  "windows:fit": (size: { width: number; height: number }) => void
  "app:quit": () => void
  /** Reveal the log file in the OS file manager. */
  "app:open-logs": () => void
  /** Write a renderer diagnostic into the app log. */
  "app:log": (entry: { level: "debug" | "info" | "warn" | "error"; scope: string; message: string; data?: unknown }) => void

  "session:state": () => SessionState
  "session:start": () => SessionState
  "session:pause": () => SessionState
  "session:resume": () => SessionState
  /** Stops transcription, saves the meeting, returns it (null when nothing was said). */
  "session:finish": () => Meeting | null
  "session:cancel": () => SessionState
  "session:audio": (pcm16: ArrayBuffer) => void
  "session:transcript": () => string
  /** The most recent finished utterance, if any. */
  "session:last-utterance": () => Utterance | null

  "chat:history": () => ChatMessage[]
  /** Streams the reply through chat:chunk / chat:message events. */
  "chat:send": (text: string) => void
  /** Answer the last thing heard in the meeting right now, whatever the hands-free setting. */
  "chat:answer-last": () => boolean
  "chat:clear": () => void
  "chat:screenshot": (prompt?: string) => ScreenshotResult

  "suggestions:state": () => SuggestionsState
  /** Regenerate the suggestions from the conversation now. */
  "suggestions:refresh": () => void
  /** Ask a suggestion (its id) or a quick action (QuickActionId); the answer streams into chat. */
  "suggestions:use": (id: string) => void

  "cloud:state": () => CloudState
  /** Starts device linking: returns the code and opens the browser. */
  "cloud:link-start": () => CloudState
  "cloud:link-cancel": () => CloudState
  "cloud:unlink": () => CloudState
  /** Opens the web dashboard signed in as this device. */
  "cloud:open-web": () => void
  "cloud:sync-now": () => CloudState

  "meetings:list": () => Meeting[]
  "meetings:get": (id: string) => Meeting | null
  "meetings:delete": (id: string) => void
  "meetings:regenerate": (id: string) => Meeting | null
}

/** Main -> renderer push events. */
export interface EventMap {
  "session:state": SessionState
  "session:transcript": TranscriptEvent
  "session:utterance": Utterance
  "windows:state": WindowsState
  "panel:tab": PanelTab
  "settings:changed": SettingsView
  "chat:message": ChatMessage
  "chat:chunk": ChatChunk
  "chat:busy": boolean
  "chat:cleared": undefined
  "suggestions:state": SuggestionsState
  "meetings:changed": undefined
  "cloud:state": CloudState
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export const INVOKE_CHANNELS: InvokeChannel[] = [
  "settings:get",
  "settings:update",
  "windows:state",
  "windows:show",
  "windows:hide",
  "windows:toggle",
  "windows:toggle-all",
  "panel:show",
  "panel:toggle",
  "panel:set-tab",
  "windows:fit",
  "app:quit",
  "app:open-logs",
  "app:log",
  "session:state",
  "session:start",
  "session:pause",
  "session:resume",
  "session:finish",
  "session:cancel",
  "session:audio",
  "session:transcript",
  "session:last-utterance",
  "chat:history",
  "chat:send",
  "chat:answer-last",
  "chat:clear",
  "chat:screenshot",
  "suggestions:state",
  "suggestions:refresh",
  "suggestions:use",
  "cloud:state",
  "cloud:link-start",
  "cloud:link-cancel",
  "cloud:unlink",
  "cloud:open-web",
  "cloud:sync-now",
  "meetings:list",
  "meetings:get",
  "meetings:delete",
  "meetings:regenerate"
]

export const EVENT_CHANNELS: EventChannel[] = [
  "session:state",
  "session:transcript",
  "session:utterance",
  "windows:state",
  "panel:tab",
  "settings:changed",
  "chat:message",
  "chat:chunk",
  "chat:busy",
  "chat:cleared",
  "suggestions:state",
  "meetings:changed",
  "cloud:state"
]

/** Shape exposed on `window.api` by the preload script. */
export interface RendererApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: Parameters<InvokeMap[K]>
  ): Promise<Awaited<ReturnType<InvokeMap[K]>>>
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void
  platform: string
}
