import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SettingsStore } from "../electron/services/settings"
import { DEFAULT_PROMPT } from "../shared/types"

const dirs: string[] = []
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igpt-settings-"))
  dirs.push(dir)
  return path.join(dir, "settings.json")
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe("SettingsStore", () => {
  it("starts from defaults and persists updates", () => {
    const file = tmpFile()
    const store = new SettingsStore(file)
    expect(store.get().outputLanguage).toBe("en")
    store.update({ outputLanguage: "ru", stealth: false })
    const reloaded = new SettingsStore(file)
    expect(reloaded.get().outputLanguage).toBe("ru")
    expect(reloaded.get().stealth).toBe(false)
  })

  it("has suggestions on by default, also for settings saved before they existed", () => {
    const file = tmpFile()
    expect(new SettingsStore(file).get().suggestions).toBe(true)
    fs.writeFileSync(file, JSON.stringify({ outputLanguage: "ru" }))
    expect(new SettingsStore(file).get().suggestions).toBe(true)
    const store = new SettingsStore(file)
    store.update({ suggestions: false })
    expect(new SettingsStore(file).get().suggestions).toBe(false)
  })

  it("creates a stable device id on first run", () => {
    const file = tmpFile()
    const first = new SettingsStore(file).deviceId()
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    expect(new SettingsStore(file).deviceId()).toBe(first)
  })

  it("never ends up without a prompt or with a dangling active id", () => {
    const store = new SettingsStore(tmpFile())
    store.update({ prompts: [], activePromptId: "nope" })
    expect(store.get().prompts).toEqual([DEFAULT_PROMPT])
    expect(store.get().activePromptId).toBe(DEFAULT_PROMPT.id)
    store.update({ prompts: [{ id: "a", title: "A", content: "x" }, { id: "b", title: "B", content: "y" }], activePromptId: "b" })
    expect(store.activePrompt().id).toBe("b")
    store.update({ prompts: [{ id: "a", title: "A", content: "x" }] })
    expect(store.activePrompt().id).toBe("a")
  })

  it("survives a corrupt file", () => {
    const file = tmpFile()
    fs.writeFileSync(file, "{not json")
    const store = new SettingsStore(file)
    expect(store.get().outputLanguage).toBe("en")
    expect(store.deviceId()).toHaveLength(32)
  })

  it("notifies listeners", () => {
    const store = new SettingsStore(tmpFile())
    const seen: string[] = []
    const off = store.onChange((s) => seen.push(s.outputLanguage))
    store.update({ outputLanguage: "fr" })
    off()
    store.update({ outputLanguage: "de" })
    expect(seen).toEqual(["fr"])
  })
})

describe("prompt migration", () => {
  it("upgrades a saved copy of any earlier default, keeps custom prompts", async () => {
    const { LEGACY_DEFAULT_SYSTEM_PROMPTS, DEFAULT_SYSTEM_PROMPT } = await import("../shared/types")
    expect(LEGACY_DEFAULT_SYSTEM_PROMPTS).toHaveLength(3)
    for (const old of LEGACY_DEFAULT_SYSTEM_PROMPTS) {
      const file = tmpFile()
      fs.writeFileSync(file, JSON.stringify({
        prompts: [
          // Saved on Windows: CRLF line endings must not defeat the comparison.
          { id: "default", title: "Meeting assistant", content: old.replace(/\n/g, "\r\n") },
          { id: "mine", title: "Mine", content: "Answer like a pirate." }
        ],
        activePromptId: "default"
      }))
      const prompts = new SettingsStore(file).get().prompts
      expect(prompts[0].content).toBe(DEFAULT_SYSTEM_PROMPT)
      expect(prompts[1].content).toBe("Answer like a pirate.")
    }
  })
})

describe("shortcuts", () => {
  it("fills missing shortcuts from defaults and keeps overrides", () => {
    const store = new SettingsStore(tmpFile())
    store.update({ shortcuts: { chat: "Alt+X" } as never })
    expect(store.get().shortcuts.chat).toBe("Alt+X")
    expect(store.get().shortcuts.listen).toBe("CommandOrControl+L")
  })

  it("moves shortcuts still on the old Ctrl+Alt defaults to the plain Ctrl ones, keeping custom keys", () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({
      shortcuts: { toggleAll: "CommandOrControl+Alt+B", chat: "CommandOrControl+Alt+C", listen: "Shift+F9", moveLeft: "CommandOrControl+Alt+Left" }
    }))
    const shortcuts = new SettingsStore(file).get().shortcuts
    expect(shortcuts.toggleAll).toBe("CommandOrControl+B")
    expect(shortcuts.chat).toBe("CommandOrControl+C")
    expect(shortcuts.moveLeft).toBe("CommandOrControl+Left")
    expect(shortcuts.listen).toBe("Shift+F9")
  })
})

describe("logger", () => {
  it("writes lines and redacts secrets", async () => {
    const { Logger, redact } = await import("../electron/services/logger")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igpt-log-"))
    dirs.push(dir)
    const file = path.join(dir, "app.log")
    const logger = new Logger(file, "debug", false)
    logger.info("audio", "capture started", { opened: ["microphone", "system"] })
    logger.error("chat", "failed", new Error("boom"))
    await new Promise((r) => setTimeout(r, 60))
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain("[audio] capture started")
    expect(text).toContain('"opened":["microphone","system"]')
    expect(text).toContain("ERROR [chat] failed Error: boom")

    expect(redact("Authorization: Bearer igpt_v1_7Qm3xLk9pZ2vT8nR4wYb6Hd1Fs5Ja0Ce")).not.toContain("Ja0Ce")
    expect(redact("key=sk-or-v1-0123456789abcdef01234567")).toBe("key=sk-or-v1-01…")
    expect(redact("nothing secret here")).toBe("nothing secret here")
  })
})
