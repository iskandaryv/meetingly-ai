import { test } from "node:test"
import assert from "node:assert/strict"
import { Quotas } from "./quotas.mjs"

function make(overrides = {}) {
  let t = Date.parse("2026-10-04T10:00:00Z")
  const q = new Quotas({ file: null, requestsPerMinutePerIp: 3, now: () => t, ...overrides })
  return { q, advance: (ms) => (t += ms) }
}

test("counters are per key and reset on a new UTC day", () => {
  const { q, advance } = make()
  q.add("u:a", "answers")
  q.add("u:a", "answers")
  q.add("u:a", "tokens", 1500)
  assert.equal(q.used("u:a").answers, 2)
  assert.equal(q.used("u:a").tokens, 1500)
  assert.equal(q.used("u:b").answers, 0)
  advance(24 * 3600 * 1000)
  assert.equal(q.used("u:a").answers, 0)
})

test("reading an unseen key creates nothing (no memory growth from probes)", () => {
  const { q } = make()
  q.used("u:nobody")
  assert.deepEqual(q.days, {})
})

test("zero or negative amounts are ignored", () => {
  const { q } = make()
  q.add("u:a", "tokens", 0)
  q.add("u:a", "tokens", -5)
  q.add("u:a", "tokens", NaN)
  assert.equal(q.used("u:a").tokens, 0)
})

test("requests in flight per key", () => {
  const { q } = make()
  q.begin("u:a")
  q.begin("u:a")
  assert.equal(q.inFlight("u:a"), 2)
  q.end("u:a")
  q.end("u:a")
  assert.equal(q.inFlight("u:a"), 0)
  assert.equal(q.flight.size, 0)
})

test("reset time is the next midnight UTC", () => {
  const { q } = make()
  assert.equal(q.resetAt(), "2026-10-05T00:00:00.000Z")
})

test("usage saved by the old relay (per device, chat/answers) reads fine", () => {
  const { q } = make()
  q.days = { "2026-10-04": { olddevice123: { chat: 5, answers: 2, audioMinutes: 1 } } }
  assert.equal(q.used("olddevice123").answers, 2)
  assert.equal(q.used("olddevice123").requests, 0)
})

test("per-ip rate limit is a sliding minute", () => {
  const { q, advance } = make()
  assert.equal(q.allowRequest("1.2.3.4"), true)
  assert.equal(q.allowRequest("1.2.3.4"), true)
  assert.equal(q.allowRequest("1.2.3.4"), true)
  assert.equal(q.allowRequest("1.2.3.4"), false)
  assert.equal(q.allowRequest("5.6.7.8"), true)
  advance(61_000)
  assert.equal(q.allowRequest("1.2.3.4"), true)
})
