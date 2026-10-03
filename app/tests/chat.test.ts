import { describe, expect, it } from "vitest"
import { buildMessages, composeSystemPrompt, gateDecision, SKIP_TOKEN } from "../electron/services/chat"
import { formatTranscript } from "../electron/services/session"
import { ANSWER_FORMAT, DEFAULT_PROMPT, type ChatMessage } from "../shared/types"

const msg = (role: ChatMessage["role"], text: string, kind: ChatMessage["kind"] = "text"): ChatMessage => ({
  id: text,
  role,
  kind,
  text,
  timestamp: 0
})

describe("buildMessages", () => {
  it("puts the system prompt first, then transcript, then history", () => {
    const out = buildMessages({
      system: "SYS",
      transcript: "we talked about kafka",
      history: [msg("user", "hi"), msg("assistant", "hello")]
    })
    expect(out[0]).toEqual({ role: "system", content: "SYS" })
    expect(out[1].role).toBe("system")
    expect(out[1].content).toContain("we talked about kafka")
    expect(out.slice(2)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ])
  })

  it("skips the transcript block when empty, drops errors, labels screenshots and heard turns", () => {
    const out = buildMessages({
      system: "SYS",
      transcript: "   ",
      history: [msg("assistant", "boom", "error"), msg("assistant", "seen", "screenshot"), msg("user", "what is kafka", "auto")]
    })
    expect(out).toHaveLength(3)
    expect(out[1].content).toBe("[Screenshot analysis]\nseen")
    expect(out[2].content).toBe("[Heard in the meeting] what is kafka")
  })

  it("keeps only the most recent history and the tail of a long transcript", () => {
    const history = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`))
    const out = buildMessages({ system: "S", transcript: "x".repeat(10000), history })
    expect(out.filter((m) => m.role !== "system")).toHaveLength(12)
    expect(out.at(-1)?.content).toBe("m29")
    expect(out[1].content.length).toBeLessThan(4200)
  })
})

describe("composeSystemPrompt", () => {
  it("adds background notes, the catch-point layout, the length rule and the language", () => {
    const out = composeSystemPrompt({ ...DEFAULT_PROMPT, notes: "I am a data engineer at Acme." }, { answerLength: "short" }, "Respond in English.")
    expect(out.startsWith(DEFAULT_PROMPT.content)).toBe(true)
    expect(out).toContain("Background about the user")
    expect(out).toContain("I am a data engineer at Acme.")
    expect(out).toContain(ANSWER_FORMAT)
    expect(out).toContain("Stop after the catch points.")
    expect(out.endsWith("Respond in English.")).toBe(true)
  })

  it("omits the background block when notes are empty", () => {
    const out = composeSystemPrompt(DEFAULT_PROMPT, { answerLength: "auto" }, "L")
    expect(out).not.toContain("Background about the user")
  })
})

describe("gateDecision", () => {
  it("waits while the reply could still be the skip marker", () => {
    expect(gateDecision("")).toBe("wait")
    expect(gateDecision("  ")).toBe("wait")
    expect(gateDecision("[")).toBe("wait")
    expect(gateDecision("[no-ans")).toBe("wait")
  })
  it("skips on the marker, answers on anything else", () => {
    expect(gateDecision(SKIP_TOKEN)).toBe("skip")
    expect(gateDecision(` ${SKIP_TOKEN}
`)).toBe("skip")
    expect(gateDecision("Kafka is a distributed log")).toBe("answer")
    expect(gateDecision("Kafka — это распределённый лог")).toBe("answer")
    expect(gateDecision("[1] first point")).toBe("answer")
  })
  it("sees through markdown around the marker, since answers open in bold", () => {
    expect(gateDecision("**")).toBe("wait")
    expect(gateDecision("**[no-")).toBe("wait")
    expect(gateDecision(`**${SKIP_TOKEN}**`)).toBe("skip")
    expect(gateDecision(`_${SKIP_TOKEN}_`)).toBe("skip")
    expect(gateDecision("**Kafka is a distributed log.**")).toBe("answer")
  })
})

describe("formatTranscript", () => {
  const seg = (text: string, speaker: number | null) => ({ text, timestamp: 0, confidence: 1, speaker })
  it("joins plain segments with spaces when there is no diarization", () => {
    expect(formatTranscript([seg("hello", null), seg("world", null)])).toBe("hello world")
  })
  it("labels speaker changes and merges consecutive turns", () => {
    const out = formatTranscript([seg("hi", 0), seg("there", 0), seg("hello", 1), seg("back", 0)])
    expect(out).toBe("Speaker 1: hi there\nSpeaker 2: hello\nSpeaker 1: back")
  })
})

describe("ChatService priorities", () => {
  it("a screen analysis is not blocked by an auto-answer check still deciding", async () => {
    const { ChatService, SKIP_TOKEN } = await import("../electron/services/chat")
    const { DEFAULT_PROMPT } = await import("../shared/types")
    let finishCheck: (() => void) | null = null
    const llm = {
      // The auto-answer check streams nothing for a while, then declines.
      chat: (_m: unknown, onChunk?: (d: string) => void) =>
        new Promise<{ text: string }>((resolve) => {
          finishCheck = () => {
            onChunk?.(SKIP_TOKEN)
            resolve({ text: SKIP_TOKEN })
          }
        }),
      vision: async () => ({ text: "A code editor with a failing test.", tokens: 10 }),
      languageInstruction: () => ""
    }
    const chat = new ChatService({
      settings: { get: () => ({ autoAnswer: "questions", answerLength: "auto" }), activePrompt: () => DEFAULT_PROMPT } as never,
      llm: llm as never,
      session: { transcriptText: () => "", getLastUtterance: () => null } as never,
      capture: async () => ({ base64: "x", width: 10, height: 10 }) as never
    })
    const check = chat.autoAnswer({ text: "We moved the standup to Thursday.", speaker: null, channel: "them", timestamp: Date.now() })
    const shot = await chat.screenshot()
    expect(shot.text).toContain("code editor")
    finishCheck!()
    await check
    const kinds = chat.getHistory().map((m) => m.kind)
    expect(kinds).toEqual(["screenshot"])
  })

  it("never auto-answers the user's own microphone", async () => {
    const { ChatService } = await import("../electron/services/chat")
    let calls = 0
    const chat = new ChatService({
      settings: { get: () => ({ autoAnswer: "always", answerLength: "auto" }) } as never,
      llm: { chat: async () => { calls++; return { text: "x" } } } as never,
      session: { transcriptText: () => "" } as never,
      capture: async () => ({}) as never
    })
    await chat.autoAnswer({ text: "What is Kafka, I would say it is a log", speaker: null, channel: "you", timestamp: Date.now() })
    expect(calls).toBe(0)
  })
})
