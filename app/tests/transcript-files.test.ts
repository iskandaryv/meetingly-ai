import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { transcriptFileName, transcriptText, writeTranscriptFile } from "../electron/services/transcriptFiles"
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
})
