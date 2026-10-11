import { test } from "node:test"
import assert from "node:assert/strict"
import { Quotas } from "./quotas.mjs"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

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

test("denied bursts keep rate-limit memory bounded and do not delay recovery", () => {
  const {q,advance}=make()
  for(let i=0;i<3;i++) assert.equal(q.allowRequest("fixture-ip"),true)
  advance(30_000)
  for(let i=0;i<10_000;i++) assert.equal(q.allowRequest("fixture-ip"),false)
  assert.equal(q.ipHits.get("fixture-ip").length,3)
  advance(30_001)
  assert.equal(q.allowRequest("fixture-ip"),true)
})

test("per-account rate limit is its own sliding minute, sized by the plan", () => {
  const { q, advance } = make()
  for (let i = 0; i < 2; i++) assert.equal(q.allowKey("u:1", 2), true)
  assert.equal(q.allowKey("u:1", 2), false)
  assert.equal(q.allowKey("u:2", 2), true) // another account
  assert.equal(q.allowRequest("1.2.3.4"), true) // the per-IP window is separate
  advance(61_000)
  assert.equal(q.allowKey("u:1", 2), true)
})

test("limit refusals are counted per caller and go out with the day's snapshot (not the per-network totals)", () => {
  const { q } = make()
  q.add("u:1", "answers")
  q.noteLimit("u:1", "answers_limit")
  q.noteLimit("u:1", "answers_limit")
  q.add("ipa:1.2.3.4", "answers")
  const snap = q.snapshot()
  assert.deepEqual(Object.keys(snap.keys), ["u:1"])
  assert.equal(snap.keys["u:1"].answers, 1)
  assert.deepEqual(snap.keys["u:1"].limits, { answers_limit: 2 })
  assert.equal(q.used("u:1").answers, 1) // limits don't leak into the counters the app sees
})

test("a new day hands the finished one over before dropping it", () => {
  let t = Date.UTC(2026, 9, 10, 23, 59)
  const handed = []
  const q = new Quotas({ file: null, requestsPerMinutePerIp: 3, now: () => t, onRollover: (day, keys) => handed.push([day, keys]) })
  q.add("u:1", "answers", 4)
  q.add("ipa:9.9.9.9", "answers")
  t += 120_000
  q.add("u:1", "answers")
  assert.deepEqual(handed, [["2026-10-10", { "u:1": { answers: 4 } }]])
  assert.equal(q.used("u:1").answers, 1)
})

test("the scheduled flush rolls a quiet day over without new requests", async () => {
  const handed=[]
  const {q,advance}=make({onRollover:(day,keys)=>{handed.push({day,keys});return true}})
  q.add("u:1","answers",4)
  advance(24*3600*1000)
  q.flush()
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(handed,[{day:"2026-10-04",keys:{"u:1":{answers:4}}}])
  assert.equal(q.days["2026-10-04"],undefined)
})

test("failed completed-day delivery survives restart and is cleared only after acknowledgement", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"meetingly-usage-test-")), file=path.join(dir,"usage.json")
  const {q,advance}=make({file,onRollover:async()=>false})
  let restored
  try {
    q.add("u:1","answers",7)
    advance(24*3600*1000);q.flush()
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(JSON.parse(fs.readFileSync(file))["2026-10-04"]["u:1"].answers,7)
    clearInterval(q.timer)
    const delivered=[]
    restored=new Quotas({file,requestsPerMinutePerIp:3,now:()=>Date.parse("2026-10-05T11:00:00Z"),onRollover:async(day,keys)=>{delivered.push({day,keys});return true}})
    restored.flush();await new Promise(resolve=>setImmediate(resolve))
    assert.equal(delivered[0].keys["u:1"].answers,7)
    assert.equal(JSON.parse(fs.readFileSync(file))["2026-10-04"],undefined)
  } finally { clearInterval(q.timer);if(restored)clearInterval(restored.timer);fs.rmSync(dir,{recursive:true,force:true}) }
})
