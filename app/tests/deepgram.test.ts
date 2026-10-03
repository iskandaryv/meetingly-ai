import { describe, expect, it } from "vitest"
import { parseDeepgramMessage } from "../electron/services/deepgram"
import { titleFromTranscript } from "../electron/services/session"

describe("parseDeepgramMessage", () => {
  it("returns transcript events for Results with text, speech_final and the speaker", () => {
    const raw = JSON.stringify({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "  hello there ", confidence: 0.93, words: [{ word: "hello", speaker: 1 }] }] }
    })
    expect(parseDeepgramMessage(raw)).toEqual({ text: "hello there", isFinal: true, speechFinal: true, confidence: 0.93, speaker: 1 })
  })

  it("reports a null speaker when diarization is absent", () => {
    const raw = JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hi", confidence: 0.5 }] } })
    expect(parseDeepgramMessage(raw)).toEqual({ text: "hi", isFinal: false, speechFinal: false, confidence: 0.5, speaker: null })
  })

  it("ignores metadata, empty transcripts and junk", () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: "Metadata" }))).toBeNull()
    expect(parseDeepgramMessage(JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript: "" }] } }))).toBeNull()
    expect(parseDeepgramMessage("not json")).toBeNull()
  })
})

describe("titleFromTranscript", () => {
  it("uses the first sentence when it is a sensible length", () => {
    expect(titleFromTranscript("Let us talk about the migration plan. Then budgets.")).toBe("Let us talk about the migration plan")
  })
  it("truncates long openers and falls back when empty", () => {
    expect(titleFromTranscript("a".repeat(100))).toHaveLength(58)
    expect(titleFromTranscript("   ")).toBe("Untitled meeting")
  })
})
