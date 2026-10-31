import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it } from "vitest"
import { RecordingSession, type TranscriptionSocket } from "../electron/services/session"
import { SettingsStore } from "../electron/services/settings"
import { MeetingStore } from "../electron/services/meetings"
import { ReportGenerator } from "../electron/services/reports"
import type { Llm } from "../electron/services/llm"

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
  const reported: string[] = []
  const meetings = new MeetingStore(path.join(dir, "meetings.json"))
  const session = new RecordingSession({
    settings,
    meetings,
    reports: { generate: async (id: string) => (reported.push(id), null) } as unknown as ReportGenerator,
    createSocket: (_device, language) => {
      const socket = new FakeSocket(language, opts.manual === true && sockets.length === 0)
      sockets.push(socket)
      return socket
    },
    onFinished: (m) => finished.push(m.fullTranscriptText),
    onDiscarded: () => discarded++
  })
  settings.onChange(() => session.syncEngine())
  return { settings, session, sockets, finished, reported, meetings, discarded: () => discarded }
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

  it("keeps a meeting on this computer: no report, marked local, completed; reports run again when it's off", async () => {
    const { settings, session, sockets, reported, meetings } = setup()
    settings.update({ keepMeetingsLocal: true })
    await session.start()
    sockets[0].say("Confidential numbers.")
    const kept = await session.finish()
    expect(kept?.localOnly).toBe(true)
    expect(kept?.status).toBe("completed")
    expect(meetings.get(kept!.id)?.localOnly).toBe(true)
    expect(reported).toEqual([])

    settings.update({ keepMeetingsLocal: false })
    await session.start()
    sockets[1].say("Normal call.")
    const normal = await session.finish()
    expect(normal?.localOnly).toBeUndefined()
    expect(reported).toEqual([normal!.id])
  })

  it("never sends a kept meeting to the AI for a report, even when asked", async () => {
    const { settings, session, sockets, meetings } = setup()
    settings.update({ keepMeetingsLocal: true })
    await session.start()
    sockets[0].say("Secret plan.")
    const kept = await session.finish()
    let calls = 0
    const llm = { chat: async () => (calls++, { text: "**TITLE:**\nx" }) } as unknown as Llm
    const reports = new ReportGenerator({ llm, meetings, settings })
    await reports.generate(kept!.id)
    await reports.resumeUnfinished()
    expect(calls).toBe(0)
    expect(meetings.get(kept!.id)?.summary).toBeUndefined()
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
