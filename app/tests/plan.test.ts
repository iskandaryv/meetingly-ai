import { describe, expect, it } from "vitest"
import { PlanService } from "../electron/services/plan"
import { relayIdentity } from "../electron/services/relayAuth"
import { describeRelayError } from "../electron/services/llm"

function settings(token?: string) {
  return {
    get: () => ({ cloud: token ? { token } : null }) as never,
    deviceId: () => "device1234",
    appVersion: () => "1.1.0"
  }
}

describe("relayIdentity", () => {
  it("always says which build is calling; adds the account only when one is linked", () => {
    expect(relayIdentity(settings())).toEqual({ "X-Device-Id": "device1234", "X-Meetingly-Client": "1.1.0" })
    expect(relayIdentity(settings("tok"))["X-Meetingly-Account"]).toBe("tok")
  })
})

describe("PlanService", () => {
  const usage = { plan: "free", used: { answers: 37, vision: 1, listening: 20, reports: 0 }, limits: { answers: 100, vision: 10, listening: 300, reports: 5 }, resetAt: "2026-10-05T00:00:00.000Z" }

  it("reads plan and usage from the relay, sending the account", async () => {
    let seen: Record<string, string> = {}
    const plan = new PlanService({
      settings: settings("tok"),
      relayUrl: "http://relay.test",
      fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
        seen = init.headers
        return new Response(JSON.stringify(usage), { status: 200 })
      }) as never
    })
    const states: string[] = []
    plan.on("state", (s) => states.push(s.status))
    const state = await plan.refresh()
    expect(state).toMatchObject({ status: "ok", plan: "free", used: { answers: 37 }, limits: { answers: 100 } })
    expect(seen["X-Meetingly-Account"]).toBe("tok")
    expect(seen.Authorization).toMatch(/^Bearer /)
    expect(states).toEqual(["ok"])
  })

  it("no account (or an expired one) is signed-out", async () => {
    const plan = new PlanService({ settings: settings(), fetch: (async () => new Response("{}", { status: 401 })) as never })
    expect((await plan.refresh()).status).toBe("signed-out")
  })

  it("an unreachable relay is offline at first and keeps the last good state afterwards", async () => {
    let fail = true
    const plan = new PlanService({
      settings: settings("tok"),
      fetch: (async () => {
        if (fail) throw new Error("ECONNREFUSED")
        return new Response(JSON.stringify(usage), { status: 200 })
      }) as never
    })
    expect((await plan.refresh()).status).toBe("offline")
    fail = false
    await plan.refresh()
    fail = true
    expect((await plan.refresh()).status).toBe("ok")
  })
})

describe("describeRelayError", () => {
  it("shows the relay's own words for limits and sign-in", () => {
    const err = Object.assign(new Error("429 x"), { status: 429, error: { code: "answers_limit", message: "You've used today's 100 free answers. Upgrade to Pro for more." } })
    expect(describeRelayError(err)).toBe("You've used today's 100 free answers. Upgrade to Pro for more.")
    const signIn = Object.assign(new Error("401 x"), { status: 401, error: { code: "account_required", message: "Create a free Meetingly account to use AI answers." } })
    expect(describeRelayError(signIn)).toMatch(/free Meetingly account/)
  })

  it("keeps the generic wording for errors without a code", () => {
    expect(describeRelayError(Object.assign(new Error("429"), { status: 429 }))).toMatch(/Daily limit reached/)
    expect(describeRelayError(Object.assign(new Error("401"), { status: 401 }))).toMatch(/no longer accepted/)
  })
})
