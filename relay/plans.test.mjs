import { test } from "node:test"
import assert from "node:assert/strict"
import { chargeFor, checkBudget, PAID, planName, PLANS, taskSpec } from "./plans.mjs"

const zero = { requests: 0, answers: 0, vision: 0, listening: 0, reports: 0, tokens: 0, audioMinutes: 0 }

test("each tier gets more than the one below; only Unlimited (and old guest builds) transcribe in the cloud", () => {
  for (const field of Object.keys(PLANS.free)) {
    if (field === "audioMinutes") continue
    assert.ok(PLANS.unlimited[field] > PLANS.pro[field], `unlimited ${field}`)
    assert.ok(PLANS.pro[field] > PLANS.free[field], `pro ${field}`)
    assert.ok(PLANS.free[field] >= PLANS.guest[field], `free ${field}`)
  }
  assert.equal(PLANS.free.audioMinutes, 0)
  assert.equal(PLANS.pro.audioMinutes, 0)
  assert.ok(PLANS.unlimited.audioMinutes > 0)
  assert.deepEqual([...PAID], ["pro", "unlimited"])
})

test("every task draws from its own budget", () => {
  const f = PLANS.free
  assert.equal(checkBudget("free", { ...zero, answers: f.answers }, "answer").code, "answers_limit")
  assert.equal(checkBudget("free", { ...zero, answers: f.answers }, "suggest"), null) // suggestions don't spend answers
  assert.equal(checkBudget("free", { ...zero, listening: f.listening }, "suggest").code, "listening_limit")
  assert.equal(checkBudget("free", { ...zero, listening: f.listening }, "answer"), null) // a question you ask still works
  assert.equal(checkBudget("free", { ...zero, vision: f.vision }, "vision").code, "vision_limit")
  assert.equal(checkBudget("free", { ...zero, reports: f.reports }, "report").code, "reports_limit")
  assert.equal(checkBudget("pro", { ...zero, answers: f.answers }, "answer"), null)
})

test("a hands-free check needs answers and listening left", () => {
  assert.equal(checkBudget("free", { ...zero, listening: PLANS.free.listening }, "auto").code, "listening_limit")
  assert.equal(checkBudget("free", { ...zero, answers: PLANS.free.answers }, "auto").code, "answers_limit")
  assert.equal(checkBudget("free", zero, "auto"), null)
})

test("relabelling a task can't escape the token ceiling", () => {
  for (const task of ["answer", "auto", "vision", "suggest", "report"]) {
    assert.equal(checkBudget("free", { ...zero, tokens: PLANS.free.tokens }, task).code, "daily_limit")
  }
})

test("messages point each plan one step up; Unlimited only hears about fair use", () => {
  assert.match(checkBudget("free", { ...zero, answers: 50 }, "answer").message, /50 free answers.*Upgrade for more/)
  assert.match(checkBudget("pro", { ...zero, answers: 300 }, "answer").message, /300 answers.*Upgrade to Unlimited/)
  assert.match(checkBudget("guest", { ...zero, answers: 20 }, "answer").message, /Update Meetingly and sign in/)
  const unlimited = checkBudget("unlimited", { ...zero, answers: PLANS.unlimited.answers }, "answer").message
  assert.match(unlimited, /fair-use/)
  assert.doesNotMatch(unlimited, /Upgrade/)
})

test("an unknown plan name gets the free budget", () => {
  assert.equal(planName("platinum"), "free")
  assert.equal(planName("toString"), "free")
  assert.equal(planName("unlimited"), "unlimited")
  assert.equal(checkBudget("platinum", { ...zero, answers: 50 }, "answer").code, "answers_limit")
})

test("what a finished request is charged to", () => {
  assert.equal(chargeFor("answer", "answer"), "answers")
  assert.equal(chargeFor("answer", "empty"), null)
  assert.equal(chargeFor("auto", "answer"), "answers")
  assert.equal(chargeFor("auto", "skip"), "listening")
  assert.equal(chargeFor("vision", "answer"), "vision")
  assert.equal(chargeFor("suggest", "empty"), "listening")
  assert.equal(chargeFor("report", "answer"), "reports")
  assert.equal(chargeFor("", "answer"), "answers") // 1.0.0
})

test("unknown tasks are refused; suggestions are capped small and never streamed", () => {
  assert.equal(taskSpec("toString"), null)
  assert.equal(taskSpec("whatever"), null)
  assert.equal(taskSpec("suggest").noStream, true)
  assert.ok(taskSpec("suggest").maxTokens < taskSpec("answer").maxTokens)
})
