import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it } from "vitest"
import { RecordingSession, type TranscriptionSocket } from "../electron/services/session"
import { SettingsStore } from "../electron/services/settings"
import { MeetingStore } from "../electron/services/meetings"
import type { ReportGenerator } from "../electron/services/reports"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A transcription engine that opens when told to (`open()`), or at once. */
class FakeSocket extends EventEmitter implements TranscriptionSocket {
  isOpen = false
  closed = false
  private release: (() => void) | null = null
  constructor(readonly language: string, private readonly manual: boolean) {
    super()
  }
  connect(): Promise<void> {
    if (!this.manual) {
      this.isOpen = true
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.release = () => {
        this.isOpen = true
        resolve()
      }
    })
  }
  open(): void {
    this.release?.()
  }
  sendAudio(): void {}
  close(): void {
    this.closed = true
    this.isOpen = false
  }
  say(text: string): void {
    this.emit("transcript", { text, isFinal: true, speechFinal: true, confidence: 1, speaker: null, channel: "them" })
  }
}

function setup(opts: { manual?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-session-"))
  dirs.push(dir)
  const settings = new SettingsStore(path.join(dir, "settings.json"))
  const sockets: FakeSocket[] = []
  let discarded = 0
  const finished: string[] = []
  const session = new RecordingSession({
    settings,
    meetings: new MeetingStore(path.join(dir, "meetings.json")),
    reports: { generate: async () => null } as unknown as ReportGenerator,
    createSocket: (_device, language) => {
      const socket = new FakeSocket(language, opts.manual === true && sockets.length === 0)
      sockets.push(socket)
      return socket
    },
    onFinished: (m) => finished.push(m.fullTranscriptText),
    onDiscarded: () => discarded++
  })
  settings.onChange(() => session.syncEngine())
  return { settings, session, sockets, finished, discarded: () => discarded }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("RecordingSession", () => {
  it("switches the meeting language mid-session and keeps the transcript so far", async () => {
    const { settings, session, sockets } = setup()
    await session.start()
    sockets[0].say("Hello everyone.")
    settings.update({ audioLanguage: "ru" })
    await tick()
    expect(sockets.map((s) => s.language)).toEqual(["en", "ru"])
    expect(sockets[0].closed).toBe(true)
    sockets[1].say("Привет всем.")
    const meeting = await session.finish()
    expect(meeting?.transcript.map((s) => s.text)).toEqual(["Hello everyone.", "Привет всем."])
    expect(meeting?.language).toBe("ru")
  })

  it("leaves the engine alone when something else changes", async () => {
    const { settings, session, sockets } = setup()
    await session.start()
    settings.update({ suggestions: true, answerLength: "short" })
    await tick()
    expect(sockets).toHaveLength(1)
    session.cancel()
  })

  it("applies a language picked while the engine was still starting", async () => {
    const { settings, session, sockets } = setup({ manual: true })
    const started = session.start()
    settings.update({ audioLanguage: "de" })
    await tick()
    expect(sockets).toHaveLength(1)
    sockets[0].open()
    await started
    await tick()
    expect(sockets.map((s) => s.language)).toEqual(["en", "de"])
    session.cancel()
  })

  it("does not open an engine when idle", async () => {
    const { settings, sockets } = setup()
    settings.update({ audioLanguage: "fr" })
    await tick()
    expect(sockets).toHaveLength(0)
  })

  it("offers the transcript so far as a draft while listening, and nothing when idle", async () => {
    const { session, sockets } = setup()
    expect(session.draft()).toBeNull()
    await session.start()
    expect(session.draft()).toBeNull()
    sockets[0].say("First point.")
    sockets[0].say("Second point.")
    const draft = session.draft()
    expect(draft?.transcript).toHaveLength(2)
    expect(draft?.fullTranscriptText).toBe("Them: First point. Second point.")
    await session.finish()
    expect(session.draft()).toBeNull()
  })

  it("tells main about a discard, not about a finish or an idle cancel", async () => {
    const { session, sockets, finished, discarded } = setup()
    session.cancel()
    expect(discarded()).toBe(0)
    await session.start()
    sockets[0].say("Keep this.")
    await session.finish()
    expect(finished).toEqual(["Them: Keep this."])
    expect(discarded()).toBe(0)
    await session.start()
    sockets[1].say("Throw this away.")
    session.cancel()
    expect(discarded()).toBe(1)
    expect(finished).toHaveLength(1)
  })
})
