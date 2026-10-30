import { afterEach, describe, expect, it, vi } from "vitest"
import { AudioHistory, SAMPLE_RATE, utteranceWindow } from "../electron/services/asrAudio"
import { RefineQueue, type FinalText } from "../electron/services/refineQueue"

const sec = (s: number) => Math.round(s * SAMPLE_RATE)

describe("AudioHistory", () => {
  it("keeps the last samples across the ring's edge and converts them to 16-bit", () => {
    const h = new AudioHistory(10)
    h.push(Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]))
    h.push(Float32Array.from([0.7, 0.8, 0.9, 1, -1, -0.5]))
    expect(h.total).toBe(12)
    // Samples 0 and 1 are gone; 2..11 are kept.
    const all = Array.from(h.slice16(0, 12)).map((v) => Math.round((v / 32767) * 10) / 10)
    expect(all).toEqual([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, -1, -0.5])
    expect(h.slice16(10, 12).length).toBe(2)
    expect(h.slice16(11, 30).length).toBe(1)
  })

  it("takes a push longer than itself by its end", () => {
    const h = new AudioHistory(3)
    h.push(Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5]))
    expect(h.total).toBe(5)
    expect(Array.from(h.slice16(0, 5)).map((v) => Math.round((v / 32767) * 10) / 10)).toEqual([0.3, 0.4, 0.5])
  })
})

describe("utteranceWindow", () => {
  it("opens 2 s before the first words, but not before the previous utterance ended", () => {
    expect(utteranceWindow({ end: sec(20), prevEnd: sec(5), firstText: sec(12) })).toEqual([sec(10), sec(20)])
    // Words right after the last utterance: start just before where it ended, not inside it.
    expect(utteranceWindow({ end: sec(20), prevEnd: sec(11), firstText: sec(12) })).toEqual([sec(10.8), sec(20)])
  })

  it("is at most 29.5 s, keeping the end; without first words it starts at the previous end", () => {
    expect(utteranceWindow({ end: sec(100), prevEnd: 0, firstText: sec(60) })).toEqual([sec(70.5), sec(100)])
    expect(utteranceWindow({ end: sec(10), prevEnd: sec(4), firstText: -1 })).toEqual([sec(3.8), sec(10)])
    expect(utteranceWindow({ end: sec(1), prevEnd: 0, firstText: 0 })).toEqual([0, sec(1)])
  })
})

describe("RefineQueue", () => {
  afterEach(() => vi.useRealTimers())
  const final = (channel: number, text: string): FinalText => ({ channel, text, speechFinal: true })

  it("hands on the second pass's text, or the live text when it comes back empty", () => {
    const out: [string, boolean][] = []
    const q = new RefineQueue((f, refined) => out.push([f.text, refined]))
    const a = q.hold(final(1, "helo world"))
    const b = q.hold(final(1, "how are yu"))
    expect(q.waitingText(1)).toBe("helo world how are yu")
    expect(q.waitingText(0)).toBe("")
    q.resolve(a, "Hello world.")
    q.resolve(b, "  ")
    expect(out).toEqual([["Hello world.", true], ["how are yu", false]])
    expect(q.size).toBe(0)
  })

  it("keeps each channel's order: a later utterance done first releases the earlier one as it was", () => {
    const out: string[] = []
    const q = new RefineQueue((f) => out.push(`${f.channel}:${f.text}`))
    const a = q.hold(final(1, "first"))
    const other = q.hold(final(0, "mine"))
    const b = q.hold(final(1, "second"))
    q.resolve(b, "Second.")
    expect(out).toEqual(["1:first", "1:Second."])
    q.resolve(a, "First.") // already gone: ignored
    q.resolve(other, "Mine.")
    expect(out).toEqual(["1:first", "1:Second.", "0:Mine."])
  })

  it("lets an utterance go as it was after the timeout, and drops the late answer", () => {
    vi.useFakeTimers()
    const out: string[] = []
    const q = new RefineQueue((f) => out.push(f.text), 1000)
    const a = q.hold(final(1, "slow one"))
    vi.advanceTimersByTime(999)
    expect(out).toEqual([])
    vi.advanceTimersByTime(1)
    expect(out).toEqual(["slow one"])
    q.resolve(a, "Slow one.")
    expect(out).toEqual(["slow one"])
  })

  it("never lets more than a few wait (the oldest go on), and flush hands on everything", () => {
    const out: string[] = []
    const q = new RefineQueue((f) => out.push(f.text), 8000, 2)
    q.hold(final(1, "a"))
    q.hold(final(0, "b"))
    q.hold(final(1, "c"))
    expect(out).toEqual(["a"])
    q.flush()
    expect(out).toEqual(["a", "b", "c"])
    expect(q.size).toBe(0)
  })
})
