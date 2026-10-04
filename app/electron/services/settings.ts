import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  DEFAULT_PROMPT,
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  LANGUAGES,
  LEGACY_DEFAULT_SHORTCUTS,
  RETIRED_DEFAULT_SHORTCUTS,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
  type Prompt,
  type Settings,
  type SettingsView,
  type ShortcutAction
} from "../../shared/types"
import type { LanguageCode } from "../../shared/types"
import { resolveLocale } from "../../shared/i18n"

/**
 * Persistent JSON settings. One file, one object, atomic writes.
 */
export class SettingsStore extends EventEmitter {
  private data: Settings
  private shortcutConflicts: ShortcutAction[] = []

  constructor(
    private readonly file: string,
    private readonly meta: { version: string; platform: string; locale?: string } = { version: "0.0.0", platform: process.platform }
  ) {
    super()
    this.data = this.load()
    if (!this.data.deviceId) {
      this.data.deviceId = randomUUID().replace(/-/g, "")
      this.persist()
    }
  }

  get(): Settings {
    return { ...this.data, prompts: this.data.prompts.map((p) => ({ ...p })) }
  }

  /** `origin` tells listeners where a change came from so sync never echoes its own writes. */
  update(patch: Partial<Settings>, origin: "local" | "cloud" = "local"): Settings {
    const next = normalize({ ...this.data, ...patch })
    this.data = next
    this.persist()
    this.emit("change", this.get(), origin)
    return this.get()
  }

  onChange(listener: (settings: Settings, origin: "local" | "cloud") => void): () => void {
    this.on("change", listener)
    return () => this.off("change", listener)
  }

  deviceId(): string {
    return this.data.deviceId
  }

  /** The interface language: the system language when Meetingly speaks it, else English. */
  uiLocale(): LanguageCode {
    return resolveLocale("auto", this.meta.locale ?? "en")
  }

  /** This build's version (sent to the relay, which treats builds before accounts as guests). */
  appVersion(): string {
    return this.meta.version
  }

  activePrompt(): Prompt {
    return this.data.prompts.find((p) => p.id === this.data.activePromptId) ?? this.data.prompts[0] ?? DEFAULT_PROMPT
  }

  /** Recorded by the shortcut manager; not persisted. */
  setShortcutConflicts(actions: ShortcutAction[]): void {
    this.shortcutConflicts = actions
    this.emit("conflicts", actions)
  }

  view(): SettingsView {
    const settings = this.get()
    return {
      ...settings,
      // The device token never leaves the main process.
      cloud: settings.cloud ? { ...settings.cloud, token: "" } : null,
      // Nor does the API key.
      ownKey: settings.ownKey ? { baseUrl: settings.ownKey.baseUrl, model: settings.ownKey.model, hasKey: Boolean(settings.ownKey.key) } : null,
      version: this.meta.version,
      platform: this.meta.platform,
      uiLocale: this.uiLocale(),
      shortcutConflicts: [...this.shortcutConflicts]
    }
  }

  private load(): Settings {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Settings> & { __v?: number }
        // v2: "microphone" used to be the silent default; nobody chose it. Move to mic + system.
        if ((raw.__v ?? 1) < SETTINGS_VERSION && raw.audioSource === "microphone") raw.audioSource = "both"
        return normalize({ ...DEFAULT_SETTINGS, ...raw })
      }
    } catch (err) {
      console.error("[settings] failed to read settings, using defaults:", err)
    }
    return normalize({ ...DEFAULT_SETTINGS })
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ ...this.data, __v: SETTINGS_VERSION }, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error("[settings] failed to write settings:", err)
    }
  }
}

const SETTINGS_VERSION = 2

export function normalize(s: Settings): Settings {
  const squash = (t: string) => t.replace(/\s+/g, " ").trim()
  const prompts = (Array.isArray(s.prompts) && s.prompts.length > 0
    ? s.prompts.filter((p) => p && typeof p.id === "string" && typeof p.content === "string")
    : [DEFAULT_PROMPT]
  ).map((p) =>
    // A prompt still on an earlier default follows the current one; edited prompts stay as they are.
    LEGACY_DEFAULT_SYSTEM_PROMPTS.some((old) => squash(p.content) === squash(old)) ? { ...p, content: DEFAULT_PROMPT.content } : p
  )
  const activePromptId = prompts.some((p) => p.id === s.activePromptId) ? s.activePromptId : prompts[0].id
  const shortcuts = { ...DEFAULT_SHORTCUTS }
  for (const key of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
    const v = s.shortcuts?.[key]
    // A shortcut still on an earlier default (Ctrl+Alt chords, Ctrl+C for chat) follows the current one;
    // custom ones stay.
    if (typeof v === "string" && v.trim() !== LEGACY_DEFAULT_SHORTCUTS[key] && v.trim() !== RETIRED_DEFAULT_SHORTCUTS[key]) shortcuts[key] = v.trim()
  }
  return {
    ...s,
    deviceId: typeof s.deviceId === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(s.deviceId) ? s.deviceId : "",
    prompts: prompts.length > 0 ? prompts : [DEFAULT_PROMPT],
    activePromptId,
    shortcuts,
    cloud: s.cloud && typeof s.cloud.token === "string" && s.cloud.token ? s.cloud : null,
    ownKey:
      s.ownKey && typeof s.ownKey.baseUrl === "string" && /^https?:\/\//i.test(s.ownKey.baseUrl) && typeof s.ownKey.model === "string" && s.ownKey.model
        ? { baseUrl: s.ownKey.baseUrl, model: s.ownKey.model, key: typeof s.ownKey.key === "string" ? s.ownKey.key : "" }
        : null,
    outputLanguage: LANGUAGES.some((l) => l.code === s.outputLanguage) ? s.outputLanguage : "en",
    audioLanguage: LANGUAGES.some((l) => l.code === s.audioLanguage) ? s.audioLanguage : "en",
    transcriptionEngine: s.transcriptionEngine === "cloud" ? "cloud" : "local",
    suggestions: s.suggestions !== false
  }
}
