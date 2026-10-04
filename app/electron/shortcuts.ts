import { globalShortcut } from "electron"
import type { ShortcutAction, Shortcuts } from "../shared/types"
import type { ChatService } from "./services/chat"
import type { RecordingSession } from "./services/session"
import type { SettingsStore } from "./services/settings"
import type { WindowManager } from "./windows/WindowManager"
import { copyFocusedSelection } from "./copy"
import { isCopyChord } from "./copy-menu"

interface Deps {
  settings: SettingsStore
  windows: WindowManager
  session: RecordingSession
  chat: ChatService
}

/**
 * Global shortcuts, read from settings and re-registered whenever they change.
 * Conflicts (another app already owns the key) are recorded on the settings
 * store so the Settings page can show them.
 */
export class ShortcutManager {
  private readonly actions: Record<ShortcutAction, () => void>

  constructor(private readonly deps: Deps) {
    const { windows, session, chat } = deps
    this.actions = {
      showToolbar: () => windows.centerMain(),
      toggleAll: () => windows.toggleAll(),
      chat: () => windows.togglePanel("answers"),
      dashboard: () => windows.toggle("dashboard"),
      screenshot: () => {
        windows.showPanel("answers")
        void chat.screenshot().catch(() => {})
      },
      listen: () => {
        const { status } = session.state()
        if (status === "idle") {
          windows.showPanel("transcript")
          void session.start().catch(() => {})
        } else if (status === "recording") session.pause()
        else if (status === "paused") session.resume()
      },
      moveLeft: () => windows.moveMain(-1, 0),
      moveRight: () => windows.moveMain(1, 0),
      moveUp: () => windows.moveMain(0, -1),
      moveDown: () => windows.moveMain(0, 1)
    }
  }

  /** (Re)register everything from the current settings. Returns the actions that failed. */
  register(): ShortcutAction[] {
    globalShortcut.unregisterAll()
    const shortcuts = this.deps.settings.get().shortcuts
    const failed: ShortcutAction[] = []
    for (const action of Object.keys(this.actions) as ShortcutAction[]) {
      const accelerator = shortcuts[action]?.trim()
      if (!accelerator) continue
      let ok = false
      try {
        const run = this.actions[action]
        // Bound to Ctrl+C: selected text in a Meetingly window is copied instead (Windows gives the key to
        // the shortcut, never to the window).
        const handler = isCopyChord(accelerator) ? () => void copyFocusedSelection().then((copied) => copied || run()) : run
        ok = globalShortcut.register(accelerator, handler)
      } catch {
        ok = false
      }
      if (!ok) {
        failed.push(action)
        console.warn(`[shortcuts] could not register ${action} = ${accelerator}`)
      }
    }
    this.deps.settings.setShortcutConflicts(failed)
    return failed
  }

  unregister(): void {
    globalShortcut.unregisterAll()
  }
}

export function isValidAccelerator(value: string): boolean {
  const parts = value.split("+").map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return false
  const modifiers = new Set(["CommandOrControl", "Command", "Control", "Ctrl", "Cmd", "Alt", "Option", "Shift", "Super", "Meta"])
  const key = parts[parts.length - 1]
  return parts.slice(0, -1).every((p) => modifiers.has(p)) && !modifiers.has(key) && key.length > 0
}

export type { Shortcuts }
