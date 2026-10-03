import { test } from "node:test"
import assert from "node:assert/strict"
import { Quotas } from "./quotas.mjs"

function make(overrides = {}) {
  let t = Date.parse("2026-09-17T10:00:00Z")
  const q = new Quotas({ file: null, chatPerDay: 2, audioMinutesPerDay: 10, requestsPerMinutePerIp: 3, now: () => t, ...overrides })
  return { q, advance: (ms) => (t += ms) }
}

test("chat quota resets on a new day", () => {
  const { q, advance } = make()
  assert.equal(q.allowChat("dev1"), true)
  q.countChat("dev1")
  q.countChat("dev1")
  assert.equal(q.allowChat("dev1"), false)
  assert.equal(q.allowChat("dev2"), true)
  advance(24 * 3600 * 1000)
  assert.equal(q.allowChat("dev1"), true)
})

test("answers have their own daily limit", () => {
  const { q, advance } = make({ chatPerDay: 100, answersPerDay: 2 })
  assert.equal(q.allowAnswer("d"), true)
  q.countAnswer("d")
  q.countAnswer("d")
  assert.equal(q.allowAnswer("d"), false)
  assert.equal(q.allowChat("d"), true)
  assert.equal(q.usage("d").answers, 2)
  advance(24 * 3600 * 1000)
  assert.equal(q.allowAnswer("d"), true)
})

test("usage saved before answers existed reads as zero answers", () => {
  const { q } = make({ answersPerDay: 1 })
  q.days = { [q.dayKey()]: { old: { chat: 5, audioMinutes: 0 } } }
  assert.equal(q.allowAnswer("old"), true)
})

test("audio minutes accumulate per device", () => {
  const { q } = make()
  q.countAudio("d", 4)
  q.countAudio("d", 5.5)
  assert.equal(q.allowAudio("d"), true)
  q.countAudio("d", 1)
  assert.equal(q.allowAudio("d"), false)
  assert.deepEqual(q.usage("d").audioMinutes, 11)
})

test("per-ip rate limit is a sliding minute", () => {
  const { q, advance } = make()
  assert.equal(q.allowRequest("1.1.1.1"), true)
  assert.equal(q.allowRequest("1.1.1.1"), true)
  assert.equal(q.allowRequest("1.1.1.1"), true)
  assert.equal(q.allowRequest("1.1.1.1"), false)
  assert.equal(q.allowRequest("2.2.2.2"), true)
  advance(61_000)
  assert.equal(q.allowRequest("1.1.1.1"), true)
})
