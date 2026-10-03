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
