/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AnswerSpeech } from "../src/lib/answer-speech"

class Utterance {
  lang = ""
  rate = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly text: string) {}
}

const synth = { cancel: vi.fn(), speak: vi.fn() }
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("window", { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance })
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance)
  vi.clearAllMocks()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe("answer playback", () => {
  it("waits for recording suppression and releases it on completion", async () => {
    let acknowledge!: () => void
    const active = vi.fn((playing: boolean) => playing ? new Promise<void>((r) => { acknowledge = r }) : Promise.resolve())
    const changed = vi.fn()
    const speech = new AnswerSpeech(active, changed)
    const playing = speech.play("one", "A normal answer.", "zh")
    expect(synth.speak).not.toHaveBeenCalled()
    acknowledge()
    await playing
    const utterance = synth.speak.mock.calls[0][0] as Utterance
    expect(utterance.text).toBe("A normal answer.")
    expect(utterance.lang).toBe("zh-CN")
    utterance.onend!()
    expect(active).toHaveBeenLastCalledWith(false)
    expect(changed).toHaveBeenLastCalledWith(null, false)
  })

  it("cancels a pending start when stopped", async () => {
    let acknowledge!: () => void
    const active = vi.fn((playing: boolean) => playing ? new Promise<void>((r) => { acknowledge = r }) : Promise.resolve())
    const speech = new AnswerSpeech(active, vi.fn())
    const playing = speech.play("one", "Answer.", "en")
    speech.stop()
    acknowledge()
    await playing
    expect(synth.speak).not.toHaveBeenCalled()
    expect(active).toHaveBeenLastCalledWith(false)
  })

  it("ignores completion of replaced playback and renews the current lease", async () => {
    const active = vi.fn(async () => {})
    const changed = vi.fn()
    const speech = new AnswerSpeech(active, changed)
    await speech.play("one", "First.", "en")
    const first = synth.speak.mock.calls[0][0] as Utterance
    await speech.play("two", "Second.", "en")
    first.onend!()
    expect(changed).toHaveBeenLastCalledWith("two", false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(active).toHaveBeenLastCalledWith(true)
    speech.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports unavailable voices and playback errors", async () => {
    const changed = vi.fn()
    const speech = new AnswerSpeech(async () => {}, changed)
    await speech.play("one", "Answer.", "en")
    const utterance = synth.speak.mock.calls[0][0] as Utterance
    utterance.onerror!()
    expect(changed).toHaveBeenLastCalledWith(null, true)
    vi.stubGlobal("window", {})
    await speech.play("two", "Answer.", "en")
    expect(changed).toHaveBeenLastCalledWith(null, true)
  })

  it("does not play if the recording guard fails", async () => {
    const changed = vi.fn()
    const speech = new AnswerSpeech(async () => { throw new Error("IPC failed") }, changed)
    await speech.play("one", "Answer.", "en")
    expect(synth.speak).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith(null, true)
  })
})
