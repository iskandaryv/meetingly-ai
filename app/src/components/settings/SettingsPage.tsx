import { useEffect, useState } from "react"
import { AlertTriangle, FileText, LogOut, RefreshCw, RotateCcw } from "lucide-react"
import {
  ANSWER_LENGTHS,
  AUDIO_SOURCE_LABELS,
  AUTO_ANSWER_LABELS,
  DEFAULT_SHORTCUTS,
  LANGUAGES,
  SHORTCUT_LABELS,
  type AnswerLength,
  type AudioSource,
  type AutoAnswerMode,
  type LanguageCode,
  TRANSCRIPTION_ENGINE_LABELS,
  type TranscriptionEngine,
  type SettingsView,
  type ShortcutAction,
  type Shortcuts
} from "@shared/types"
import { api, shortcutLabel } from "@/lib/api"
import { listAudioInputs, type AudioInputDevice } from "@/lib/audio"
import { useSettings } from "@/lib/hooks"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Field, Select, Toggle } from "@/components/ui/fields"
import { AccountSection } from "./AccountSection"

export function SettingsPage() {
  const [settings, update] = useSettings()
  if (!settings) return <p className="py-8 text-center text-xs text-white/50">Loading…</p>

  const platform = settings.platform
  const stealthSupported = platform !== "linux"

  return (
    <div className="space-y-3">
      <AccountSection />

      <h2 className="pt-2 text-sm font-semibold">Answers</h2>
      <Field label="Hands-free answers" hint="While listening, answer automatically when the other person asks something." inline>
        <Select value={settings.autoAnswer} onChange={(e) => update({ autoAnswer: e.target.value as AutoAnswerMode })} className="w-52">
          {(Object.keys(AUTO_ANSWER_LABELS) as AutoAnswerMode[]).map((m) => <option key={m} value={m}>{AUTO_ANSWER_LABELS[m]}</option>)}
        </Select>
      </Field>
      <Field label="Answer length" hint="How much the assistant writes per reply." inline>
        <Select value={settings.answerLength} onChange={(e) => update({ answerLength: e.target.value as AnswerLength })} className="w-52">
          {(Object.keys(ANSWER_LENGTHS) as AnswerLength[]).map((l) => <option key={l} value={l}>{ANSWER_LENGTHS[l].label}</option>)}
        </Select>
      </Field>
      <Field label="Answer language" hint="Language for chat replies, suggestions and reports." inline>
        <LanguageSelect value={settings.outputLanguage} onChange={(v) => update({ outputLanguage: v })} />
      </Field>

      <h2 className="pt-2 text-sm font-semibold">Listening</h2>
      <Field
        label="Transcription"
        hint={settings.transcriptionEngine === "local"
          ? "Speech is turned into text on this computer with NVIDIA Nemotron. Audio never leaves the device. The model (560 MB) downloads once."
          : "Speech is sent to Deepgram for transcription. Adds speaker labels and uses no CPU on this computer."}
        inline
      >
        <Select value={settings.transcriptionEngine} onChange={(e) => update({ transcriptionEngine: e.target.value as TranscriptionEngine })} className="w-56">
          {(Object.keys(TRANSCRIPTION_ENGINE_LABELS) as TranscriptionEngine[]).map((k) => <option key={k} value={k}>{TRANSCRIPTION_ENGINE_LABELS[k]}</option>)}
        </Select>
      </Field>
      <Field label="Meeting language" hint="Language spoken in the meeting (transcription)." inline>
        <LanguageSelect value={settings.audioLanguage} onChange={(v) => update({ audioLanguage: v })} />
      </Field>
      <Field label="Audio source" hint={sourceHint(platform)} inline>
        <Select value={settings.audioSource} onChange={(e) => update({ audioSource: e.target.value as AudioSource })} className="w-56">
          {(Object.keys(AUDIO_SOURCE_LABELS) as AudioSource[]).map((s) => <option key={s} value={s}>{AUDIO_SOURCE_LABELS[s]}</option>)}
        </Select>
      </Field>
      {settings.audioSource !== "system" && (
        <Field label="Input device" hint={deviceHint(platform)}>
          <DevicePicker value={settings.audioDeviceId} onChange={(id) => update({ audioDeviceId: id })} />
        </Field>
      )}

      <h2 className="pt-2 text-sm font-semibold">Behaviour</h2>
      <Field
        label="Stealth mode"
        hint={stealthSupported ? "Windows are excluded from screen sharing, recordings and screenshots." : "Not available on Linux: the desktop does not let apps hide from screen capture."}
        inline
      >
        <Toggle checked={settings.stealth && stealthSupported} onChange={(v) => update({ stealth: v })} label="Stealth mode" disabled={!stealthSupported} />
      </Field>
      <Field label="Start with the system" hint="Launch Meetingly when you log in (packaged builds only)." inline>
        <Toggle checked={settings.autoLaunch} onChange={(v) => update({ autoLaunch: v })} label="Auto launch" />
      </Field>

      <h2 className="pt-2 text-sm font-semibold">Keyboard shortcuts</h2>
      <ShortcutsEditor shortcuts={settings.shortcuts} conflicts={settings.shortcutConflicts} onChange={(s) => update({ shortcuts: s })} />

      <div className="flex items-center justify-between pt-2 text-xs text-white/50">
        <span>Meetingly {settings.version} · {platform} · device {settings.deviceId.slice(0, 8)}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => api.invoke("app:open-logs")} title="Open the folder containing the app log">
            <FileText className="h-3.5 w-3.5" /> Logs
          </Button>
          <Button variant="danger" size="sm" onClick={() => api.invoke("app:quit")}>
            <LogOut className="h-3.5 w-3.5" /> Quit
          </Button>
        </div>
      </div>
    </div>
  )
}

function sourceHint(platform: string): string {
  switch (platform) {
    case "win32":
      return "System audio is the other side of the call; it records the Windows default output device, so play the call on that device. Microphone is you."
    case "darwin":
      return "System audio needs macOS 13+ and the Screen & System Audio Recording permission. Older Macs: install BlackHole and pick it as the input device."
    case "linux":
      return "For the other side of the call, choose the \"Monitor of …\" input device below."
    default:
      return "System audio is the other side of the call. Microphone is you."
  }
}

function deviceHint(platform: string): string {
  if (platform === "linux") return "\"Monitor of …\" devices carry what you hear; the others are microphones."
  if (platform === "darwin") return "Virtual devices such as BlackHole appear here too."
  return "Leave on system default unless you use a specific microphone."
}

function DevicePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [devices, setDevices] = useState<AudioInputDevice[] | null>(null)
  const refresh = () => {
    setDevices(null)
    listAudioInputs().then(setDevices).catch(() => setDevices([]))
  }
  useEffect(refresh, [])
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="flex-1">
        <option value="">System default</option>
        {(devices ?? []).map((d) => (
          <option key={d.id} value={d.id}>{d.isMonitor ? `${d.label} (system audio)` : d.label}</option>
        ))}
        {value && devices && !devices.some((d) => d.id === value) && <option value={value}>Previously selected device (unplugged)</option>}
      </Select>
      <Button variant="ghost" size="icon-sm" onClick={refresh} title="Refresh device list" disabled={devices === null}>
        <RefreshCw className={cn("h-3.5 w-3.5", devices === null && "animate-spin")} />
      </Button>
    </div>
  )
}

const MODIFIERS = ["CommandOrControl", "Alt", "Shift"] as const

/** Click a row, press a chord. Shortcuts are global, so they must include a modifier. */
function ShortcutsEditor({ shortcuts, conflicts, onChange }: { shortcuts: Shortcuts; conflicts: ShortcutAction[]; onChange: (s: Shortcuts) => void }) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null)

  const onKeyDown = (action: ShortcutAction) => (e: React.KeyboardEvent) => {
    e.preventDefault()
    if (e.key === "Escape") return setRecording(null)
    const mods: string[] = []
    if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl")
    if (e.altKey) mods.push("Alt")
    if (e.shiftKey) mods.push("Shift")
    const key = normalizeKey(e)
    if (!key || mods.length === 0) return
    onChange({ ...shortcuts, [action]: [...mods, key].join("+") })
    setRecording(null)
  }

  const isDefault = JSON.stringify(shortcuts) === JSON.stringify(DEFAULT_SHORTCUTS)
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-2">
      {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => {
        const conflict = conflicts.includes(action)
        return (
          <div key={action} className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm">
            <span className="text-white/80">{SHORTCUT_LABELS[action]}</span>
            <div className="flex items-center gap-2">
              {conflict && (
                <span className="flex items-center gap-1 text-[11px] text-amber-300" title="Another application already uses this shortcut">
                  <AlertTriangle className="h-3.5 w-3.5" /> in use elsewhere
                </span>
              )}
              <button
                type="button"
                onClick={() => setRecording(action)}
                onBlur={() => setRecording((r) => (r === action ? null : r))}
                onKeyDown={recording === action ? onKeyDown(action) : undefined}
                className={cn(
                  "min-w-[150px] rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                  recording === action
                    ? "border-sky-400/60 bg-sky-500/20 text-sky-100"
                    : conflict
                      ? "border-amber-400/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
                      : "border-white/15 bg-black/40 text-white/85 hover:bg-white/10"
                )}
              >
                {recording === action ? "Press keys…" : shortcutLabel(shortcuts[action])}
              </button>
            </div>
          </div>
        )
      })}
      <div className="flex items-center justify-between px-2 pt-2 text-[11px] text-white/45">
        <span>Click a shortcut, then press the new combination. Modifiers: {MODIFIERS.map((m) => shortcutLabel(m)).join(", ")}.</span>
        <Button variant="ghost" size="sm" disabled={isDefault} onClick={() => onChange({ ...DEFAULT_SHORTCUTS })}>
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </Button>
      </div>
    </div>
  )
}

function normalizeKey(e: React.KeyboardEvent): string | null {
  const k = e.key
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(k)) return null
  if (k === " ") return "Space"
  if (k === "ArrowLeft") return "Left"
  if (k === "ArrowRight") return "Right"
  if (k === "ArrowUp") return "Up"
  if (k === "ArrowDown") return "Down"
  if (k.length === 1) {
    // Use the physical key so the chord works on any keyboard layout.
    const code = e.code
    if (/^Key[A-Z]$/.test(code)) return code.slice(3)
    if (/^Digit\d$/.test(code)) return code.slice(5)
    return k.toUpperCase()
  }
  return k
}

function LanguageSelect({ value, onChange }: { value: LanguageCode; onChange: (v: LanguageCode) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as LanguageCode)} className="w-52">
      {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </Select>
  )
}

export type { SettingsView }
