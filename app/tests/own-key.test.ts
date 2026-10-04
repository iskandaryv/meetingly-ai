import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Llm, describeRelayError } from "../electron/services/llm"
import { OwnKeyService, describeOwnKeyError, normalizeBaseUrl, reasoningFor, type SecretBox } from "../electron/services/ownKey"
import { PlanService } from "../electron/services/plan"
import { SettingsStore } from "../electron/services/settings"

const dirs: string[] = []
function store(): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetingly-ownkey-"))
  dirs.push(dir)
  return new SettingsStore(path.join(dir, "settings.json"), { version: "1.2.0", platform: "win32" })
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Reversible stand-in for the OS keychain, so tests can tell stored from typed. */
const box: SecretBox = { encrypt: (s) => `enc:${[...s].reverse().join("")}`, decrypt: (s) => [...s.slice(4)].reverse().join("") }

/** A tiny OpenAI-compatible server: /models, and /chat/completions (plain and streamed). */
interface Seen {
  path: string
  auth: string | undefined
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}
const seen: Seen[] = []
let reply = { status: 200, text: "OK" }
let server: http.Server
let base = ""
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, headers: req.headers, body })
      if (reply.status !== 200) {
        res.writeHead(reply.status, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "nope" } }))
      }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }] }))
      }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const part of ["Hel", "lo"]) {
          res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`)
        }
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "1", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => server.close())
afterEach(() => {
  seen.length = 0
  reply = { status: 200, text: "OK" }
})

describe("own key helpers", () => {
  it("takes the base URL however it is pasted", () => {
    expect(normalizeBaseUrl(" https://api.openai.com/v1/ ")).toBe("https://api.openai.com/v1")
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1")
  })

  it("asks reasoning models for low effort, and only them", () => {
    expect(reasoningFor("gpt-5.5")).toEqual({ reasoning_effort: "low" })
    expect(reasoningFor("openai/o4-mini")).toEqual({ reasoning_effort: "low" })
    expect(reasoningFor("gpt-4.1-mini")).toEqual({})
    expect(reasoningFor("llama3.2")).toEqual({})
  })

  it("words provider errors, and the relay wording leaves them alone", () => {
    const err = describeOwnKeyError({ status: 401 }, { baseUrl: "https://api.openai.com/v1", model: "x" })
    expect(err.message).toContain("api.openai.com")
    expect(err.message).toMatch(/key/i)
    expect(describeRelayError(err)).toBe(err.message)
    expect(describeOwnKeyError({ status: 404 }, { baseUrl: base, model: "nope-1" }).message).toContain("nope-1")
  })
})

describe("OwnKeyService", () => {
  it("lists the endpoint's models, sorted, with the typed key", async () => {
    const service = new OwnKeyService({ settings: store(), box })
    expect(await service.models({ baseUrl: base, key: "sk-test" })).toEqual(["alpha", "zeta"])
    expect(seen[0].auth).toBe("Bearer sk-test")
  })

  it("checks the choice with one request, then saves it with the key encrypted", async () => {
    const settings = store()
    await new OwnKeyService({ settings, box }).save({ baseUrl: `${base}/`, key: "sk-test", model: "alpha" })
    expect(seen.map((s) => s.path)).toEqual(["/v1/chat/completions"])
    expect(seen[0].body.model).toBe("alpha")
    expect(settings.get().ownKey).toEqual({ baseUrl: base, model: "alpha", key: box.encrypt("sk-test") })
    // The renderer never sees the key.
    expect(settings.view().ownKey).toEqual({ baseUrl: base, model: "alpha", hasKey: true })
  })

  it("keeps the saved key when only the model changes, and never for another endpoint", async () => {
    const settings = store()
    const service = new OwnKeyService({ settings, box })
    await service.save({ baseUrl: base, key: "sk-test", model: "alpha" })
    await service.save({ baseUrl: base, key: "", model: "zeta" })
    expect(seen[1].auth).toBe("Bearer sk-test")
    expect(settings.get().ownKey?.model).toBe("zeta")
    await expect(service.models({ baseUrl: "http://127.0.0.1:1/v1", key: "" })).rejects.toThrow()
  })

  it("saves nothing when the provider refuses", async () => {
    const settings = store()
    reply = { status: 401, text: "" }
    await expect(new OwnKeyService({ settings, box }).save({ baseUrl: base, key: "bad", model: "alpha" })).rejects.toThrow(/key/i)
    expect(settings.get().ownKey).toBeNull()
  })

  it("needs an address and a model", async () => {
    const service = new OwnKeyService({ settings: store(), box })
    await expect(service.save({ baseUrl: "api.openai.com", key: "k", model: "m" })).rejects.toThrow(/https/)
    await expect(service.save({ baseUrl: base, key: "k", model: " " })).rejects.toThrow()
  })
})

describe("Llm with an own key", () => {
  it("sends requests straight to the endpoint with the user's key and model, without relay headers", async () => {
    const settings = store()
    settings.update({ ownKey: { baseUrl: base, model: "alpha", key: box.encrypt("sk-test") } })
    const llm = new Llm(settings, "http://127.0.0.1:1", box)
    const res = await llm.chat([{ role: "user", content: "hi" }], undefined, "answer")
    expect(res).toEqual({ text: "OK", tokens: 4 })
    expect(seen[0].auth).toBe("Bearer sk-test")
    expect(seen[0].body.model).toBe("alpha")
    expect(seen[0].headers["x-meetingly-task"]).toBeUndefined()
    expect(seen[0].headers["x-device-id"]).toBeUndefined()
  })

  it("streams, and words a refusal for the user", async () => {
    const settings = store()
    settings.update({ ownKey: { baseUrl: base, model: "gpt-5.5", key: "" } })
    const llm = new Llm(settings, "http://127.0.0.1:1", box)
    const chunks: string[] = []
    const res = await llm.chat([{ role: "user", content: "hi" }], (d) => chunks.push(d))
    expect(chunks.join("")).toBe("Hello")
    expect(res.tokens).toBe(5)
    expect(seen[0].body.reasoning_effort).toBe("low")
    expect(seen[0].auth).toBe("Bearer none")
    reply = { status: 429, text: "" }
    await expect(llm.chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ ownKey: true })
  })
})

describe("PlanService with an own key", () => {
  it("reports own-key without asking the relay", async () => {
    const settings = store()
    settings.update({ ownKey: { baseUrl: base, model: "alpha", key: "" } })
    let called = false
    const plan = new PlanService({ settings, fetch: (async () => ((called = true), new Response("{}"))) as never })
    expect((await plan.refresh()).status).toBe("own-key")
    expect(called).toBe(false)
  })
})
