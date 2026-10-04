import { test } from "node:test"
import assert from "node:assert/strict"
import { Accounts } from "./accounts.mjs"

function fakeService(responses) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return { status: next.status, json: async () => next.body }
  }
  return { fetch, calls }
}

test("a valid token resolves to the user and plan, and is cached", async () => {
  let t = 0
  const svc = fakeService([{ status: 200, body: { userId: "u1", plan: "pro" } }])
  const a = new Accounts({ fetch: svc.fetch, now: () => t })
  assert.deepEqual(await a.resolve("tok"), { ok: true, userId: "u1", plan: "pro" })
  assert.deepEqual(await a.resolve("tok"), { ok: true, userId: "u1", plan: "pro" })
  assert.equal(svc.calls.length, 1)
  assert.equal(svc.calls[0].auth, "tok")
  assert.match(svc.calls[0].url, /\/api\/meetingly\/entitlement$/)
})

test("an unknown plan value is treated as free", async () => {
  const svc = fakeService([{ status: 200, body: { userId: "u1", plan: "platinum" } }])
  assert.equal((await new Accounts({ fetch: svc.fetch }).resolve("tok")).plan, "free")
})

test("a rejected token is not ok, and is cached briefly", async () => {
  let t = 0
  const svc = fakeService([{ status: 401, body: {} }, { status: 200, body: { userId: "u1", plan: "free" } }])
  const a = new Accounts({ fetch: svc.fetch, now: () => t, errorTtlMs: 30_000 })
  assert.deepEqual(await a.resolve("bad"), { ok: false })
  assert.deepEqual(await a.resolve("bad"), { ok: false })
  assert.equal(svc.calls.length, 1)
  t += 31_000
  assert.equal((await a.resolve("bad")).ok, true) // looked up again after the short error cache
})

test("the plan is looked up again after the cache expires (upgrades show up)", async () => {
  let t = 0
  const svc = fakeService([{ status: 200, body: { userId: "u1", plan: "free" } }, { status: 200, body: { userId: "u1", plan: "pro" } }])
  const a = new Accounts({ fetch: svc.fetch, now: () => t, ttlMs: 300_000 })
  assert.equal((await a.resolve("tok")).plan, "free")
  t += 301_000
  assert.equal((await a.resolve("tok")).plan, "pro")
})

test("when the account service is down, a stale answer is used; with nothing cached it throws", async () => {
  let t = 0
  const svc = fakeService([{ status: 200, body: { userId: "u1", plan: "pro" } }, new Error("ECONNREFUSED"), new Error("ECONNREFUSED")])
  const a = new Accounts({ fetch: svc.fetch, now: () => t, ttlMs: 1000 })
  await a.resolve("tok")
  t += 5000
  assert.equal((await a.resolve("tok")).plan, "pro")
  await assert.rejects(() => a.resolve("other"))
})
