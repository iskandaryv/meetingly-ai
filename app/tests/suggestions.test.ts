import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mergeSuggestions, parseSuggestions, SuggestionService } from "../electron/services/suggestions"
import { DEFAULT_PROMPT, QUICK_ACTIONS } from "../shared/types"

describe("parseSuggestions", () => {
  it("reads plain and fenced JSON, with prose around it", () => {
    const json = '{"topic": "Kafka", "questions": ["What is a consumer group?", "How does rebalancing work?"]}'
    expect(parseSuggestions(json)).toEqual({ topic: "Kafka", context: "", questions: ["What is a consumer group?", "How does rebalancing work?"] })
    expect(parseSuggestions("```json\n" + json + "\n```")?.questions).toHaveLength(2)
    expect(parseSuggestions("Here you go: " + json + " Hope it helps.")?.topic).toBe("Kafka")
  })

  it("drops duplicates, blanks and non-strings, squashes whitespace, keeps at most four", () => {
    const out = parseSuggestions(JSON.stringify({ topic: "  Базы   данных ", questions: ["Что такое  шардирование?", "что такое шардирование?", "", 7, "A?", "B?", "C?", "D?"] }))
    expect(out).toEqual({ topic: "Базы данных", context: "", questions: ["Что такое шардирование?", "A?", "B?", "C?"] })
  })

  it("cuts very long questions", () => {
    const out = parseSuggestions(JSON.stringify({ topic: "x", questions: ["q".repeat(300)] }))
    expect(out!.questions[0].length).toBe(140)
    expect(out!.questions[0].endsWith("…")).toBe(true)
  })

  it("returns null for anything unreadable", () => {
    expect(parseSuggestions("")).toBeNull()
    expect(parseSuggestions("no json here")).toBeNull()
    expect(parseSuggestions('{"topic": "x", "questions": "not a list"}')).toBeNull()
    expect(parseSuggestions('{"topic": "x", "questions": [')).toBeNull()
  })
})

describe("mergeSuggestions", () => {
  it("keeps the id of a question that stayed, new ids for new ones", () => {
    const out = mergeSuggestions([{ id: "a", text: "What is Kafka?" }], ["what is kafka?", "What is Flink?"])
    expect(out[0]).toEqual({ id: "a", text: "what is kafka?" })
    expect(out[1].id).not.toBe("a")
  })
})

describe("SuggestionService", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const reply = (questions: string[], topic = "Kafka") => ({ text: JSON.stringify({ topic, questions }), tokens: 0 })

  function setup(opts: { enabled?: boolean; busy?: boolean } = {}) {
    let transcript = ""
    const history: { role: string; kind: string; text: string }[] = []
    const calls: { messages: { role: string; content: string }[]; task?: string }[] = []
    const sent: { text: string; opts: unknown }[] = []
    let next: () => Promise<{ text: string; tokens: number }> = async () => reply(["What is a consumer group?"])
    const service = new SuggestionService({
      settings: { get: () => ({ suggestions: opts.enabled !== false }), activePrompt: () => DEFAULT_PROMPT } as never,
      llm: {
        chat: async (messages: { role: string; content: string }[], _onChunk?: unknown, task?: string) => {
          calls.push({ messages, task })
          return next()
        },
        languageInstruction: () => "Respond in Russian."
      } as never,
      session: { transcriptText: () => transcript },
      chat: {
        isBusy: opts.busy ?? false,
        getHistory: () => history,
        send: async (text: string, o?: unknown) => {
          sent.push({ text, opts: o })
        }
      } as never
    })
    return {
      service,
      calls,
      sent,
      history,
      say: (text: string) => {
        transcript += `${transcript ? "\n" : ""}Them: ${text}`
        service.onUtterance()
      },
      replyWith: (fn: typeof next) => {
        next = fn
      }
    }
  }

  const sentence = "Tell me how you used Kafka in your last project and how you handled exactly-once delivery."

  it("waits for enough conversation, then asks the model once after a pause", async () => {
    const t = setup()
    t.say("Hi there.")
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.calls).toHaveLength(0)

    t.say(sentence)
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].task).toBe("suggest")
    expect(t.calls[0].messages[0].content).toContain("Respond in Russian.")
    expect(t.calls[0].messages[1].content).toContain("exactly-once")
    expect(t.service.state()).toMatchObject({ topic: "Kafka", items: [{ text: "What is a consumer group?" }], updating: false })
  })

  it("respects the minimum interval between runs", async () => {
    const t = setup()
    t.say(sentence)
    await vi.advanceTimersByTimeAsync(3000)
    t.say(`${sentence} ${sentence}`)
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(t.calls).toHaveLength(2)
  })

  it("does nothing when turned off", async () => {
    const t = setup({ enabled: false })
    t.say(sentence)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.calls).toHaveLength(0)
  })

  it("keeps the old questions when a run fails", async () => {
    const t = setup()
    t.say(sentence)
    await vi.advanceTimersByTimeAsync(3000)
    t.replyWith(async () => {
      throw Object.assign(new Error("Daily chat limit reached"), { status: 429 })
    })
    await t.service.refresh()
    expect(t.service.state().items.map((s) => s.text)).toEqual(["What is a consumer group?"])
    expect(t.service.state().updating).toBe(false)
  })

  it("drops a reply that lands after the session ended", async () => {
    const t = setup()
    let finish: (v: { text: string; tokens: number }) => void = () => {}
    t.replyWith(() => new Promise((resolve) => (finish = resolve)))
    t.say(sentence)
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.service.state().updating).toBe(true)
    t.service.reset()
    finish(reply(["Late question?"]))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.service.state()).toEqual({ topic: "", items: [], updating: false })
  })

  it("asks a suggestion and never offers it again", async () => {
    const t = setup()
    t.say(sentence)
    await vi.advanceTimersByTimeAsync(3000)
    const [item] = t.service.state().items
    expect(t.service.use(item.id)).toBe(true)
    expect(t.sent).toEqual([{ text: "What is a consumer group?", opts: undefined }])
    expect(t.service.state().items).toHaveLength(0)
    // The model suggests it again: it stays gone.
    await t.service.refresh()
    expect(t.service.state().items).toHaveLength(0)
  })

  it("a quick action shows its label in chat and sends its prompt", () => {
    const t = setup()
    const action = QUICK_ACTIONS.find((a) => a.id === "say")!
    expect(t.service.use("say")).toBe(true)
    expect(t.sent).toEqual([{ text: action.label, opts: { prompt: action.prompt } }])
  })

  it("carries the model's context notes forward and marks what is new", async () => {
    const t = setup()
    t.replyWith(async () => ({ text: JSON.stringify({ topic: "Kafka", context: "Sarah, payments team at Paylane; Go, Kafka, Postgres.", questions: ["What is a consumer group?"] }), tokens: 0 }))
    t.say(sentence)
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.calls[0].messages[1].content).toContain("What you know so far: (nothing yet)")
    expect(t.calls[0].messages[1].content).not.toContain("earlier part")

    t.history.push({ role: "user", kind: "auto", text: "What is exactly-once delivery?" })
    t.replyWith(async () => reply(["How do you scale Postgres writes?"], "Postgres"))
    t.say("Let's switch to databases. Our Postgres primary is hitting write limits at peak traffic. How would you scale the writes?")
    await vi.advanceTimersByTimeAsync(25_000)
    const second = t.calls[1].messages[1].content
    expect(second).toContain("What you know so far: Sarah, payments team at Paylane")
    expect(second).toContain("Already answered on screen:\n- What is exactly-once delivery?")
    const earlier = second.indexOf("Transcript, earlier part:")
    const fresh = second.indexOf("Transcript, NEW since your last suggestions:")
    expect(earlier).toBeGreaterThan(-1)
    expect(second.slice(earlier, fresh)).toContain("exactly-once")
    expect(second.slice(fresh)).toContain("Postgres primary")
    expect(second.slice(fresh)).not.toContain("exactly-once")
    // A reply without context keeps the notes it had.
    expect(t.service.state().topic).toBe("Postgres")
  })

  it("ignores clicks while chat is busy", () => {
    const t = setup({ busy: true })
    expect(t.service.use("recap")).toBe(false)
    expect(t.sent).toHaveLength(0)
  })
})
