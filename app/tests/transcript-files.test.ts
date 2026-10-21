import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TranscriptAutosave, transcriptFileName, transcriptText, writeTranscriptFile } from "../electron/services/transcriptFiles"
import type { Meeting } from "../shared/types"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const start = new Date(2026, 9, 15, 14, 5).getTime()
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: "m1",
  title: "Weekly sync: Q4 plan?",
  startTime: start,
  endTime: start + 125_000,
  duration: 125_000,
  transcript: [
    { text: "What did we ship?", timestamp: start, confidence: 1, speaker: null, channel: "them" },
    { text: "The new onboarding.", timestamp: start + 5000, confidence: 1, speaker: null, channel: "you" },
    { text: "And the docs.", timestamp: start + 7000, confidence: 1, speaker: null, channel: "you" }
  ],
  fullTranscriptText: "",
  language: "en",
  status: "processing",
  createdAt: start,
  updatedAt: start,
  ...over
})

describe("transcript text files", () => {
  it("names the file by local date, time and a file-safe title", () => {
    expect(transcriptFileName(meeting())).toBe("2026-10-15 14-05 Weekly sync Q4 plan.txt")
    expect(transcriptFileName(meeting({ title: "" }))).toBe("2026-10-15 14-05.txt")
  })

  it("writes the title, the date and length, then each speaker's turn", () => {
    const text = transcriptText(meeting())
    const lines = text.split("\r\n")
    expect(lines[0]).toBe("Weekly sync: Q4 plan?")
    expect(lines[1]).toContain("2 min")
    expect(text).toContain("Them: What did we ship?\r\nYou: The new onboarding. And the docs.")
    expect(text).not.toMatch(/[^\r]\n/)
  })

  it("never overwrites an earlier file with the same name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-"))
    dirs.push(dir)
    const first = writeTranscriptFile(path.join(dir, "Meetingly"), meeting())
    const second = writeTranscriptFile(path.join(dir, "Meetingly"), meeting())
    expect(path.basename(first)).toBe("2026-10-15 14-05 Weekly sync Q4 plan.txt")
    expect(path.basename(second)).toBe("2026-10-15 14-05 Weekly sync Q4 plan (2).txt")
    expect(fs.readFileSync(second, "utf8")).toContain("Them: What did we ship?")
  })

  it("rewrites the session's own file as it grows (saved every minute), and renames it when the title changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-"))
    dirs.push(dir)
    const early = meeting({ title: "What did we ship", transcript: meeting().transcript.slice(0, 1) })
    const first = writeTranscriptFile(dir, early)
    const again = writeTranscriptFile(dir, meeting({ title: "What did we ship" }), first)
    expect(again).toBe(first)
    expect(fs.readFileSync(again, "utf8")).toContain("And the docs.")
    const renamed = writeTranscriptFile(dir, meeting(), again)
    expect(path.basename(renamed)).toBe("2026-10-15 14-05 Weekly sync Q4 plan.txt")
    expect(fs.readdirSync(dir)).toEqual(["2026-10-15 14-05 Weekly sync Q4 plan.txt"])
  })

  it("autosave: writes only when something new was heard, Finish completes the same file, Discard deletes it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-"))
    dirs.push(dir)
    let draft: Meeting | null = null
    const autosave = new TranscriptAutosave(dir, () => draft)
    autosave.save()
    expect(fs.readdirSync(dir)).toEqual([])
    draft = meeting({ transcript: meeting().transcript.slice(0, 2) })
    autosave.save()
    const file = path.join(dir, "2026-10-15 14-05 Weekly sync Q4 plan.txt")
    expect(fs.readFileSync(file, "utf8")).not.toContain("And the docs.")
    fs.writeFileSync(file, "touched")
    autosave.save()
    expect(fs.readFileSync(file, "utf8")).toBe("touched")
    expect(autosave.finish(meeting())).toBe(file)
    expect(fs.readFileSync(file, "utf8")).toContain("And the docs.")

    // The next session starts its own file; discarding it removes that file and nothing else.
    draft = meeting({ startTime: start + 3_600_000, title: "Second call" })
    autosave.save()
    expect(fs.readdirSync(dir)).toHaveLength(2)
    autosave.discard()
    expect(fs.readdirSync(dir)).toEqual(["2026-10-15 14-05 Weekly sync Q4 plan.txt"])
  })

  it("keeps a numbered name it already has instead of moving between numbers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-"))
    dirs.push(dir)
    const earlier = writeTranscriptFile(dir, meeting())
    const mine = writeTranscriptFile(dir, meeting())
    expect(path.basename(mine)).toBe("2026-10-15 14-05 Weekly sync Q4 plan (2).txt")
    expect(writeTranscriptFile(dir, meeting(), mine)).toBe(mine)
    expect(fs.existsSync(earlier)).toBe(true)
    expect(fs.readdirSync(dir)).toHaveLength(2)
  })
})
