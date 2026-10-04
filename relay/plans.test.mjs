import { test } from "node:test"
import assert from "node:assert/strict"
import { chargeFor, checkBudget, PLANS, taskSpec } from "./plans.mjs"

const zero = { requests: 0, answers: 0, vision: 0, listening: 0, reports: 0, tokens: 0, audioMinutes: 0 }

test("pro gets more of everything than free, and free more than guest", () => {
  for (const field of Object.keys(PLANS.free)) {
    assert.ok(PLANS.pro[field] > PLANS.free[field], `pro ${field}`)
    assert.ok(PLANS.free[field] >= PLANS.guest[field], `free ${field}`)
  }
})

test("every task draws from its own budget", () => {
  assert.equal(checkBudget("free", { ...zero, answers: 100 }, "answer").code, "answers_limit")
  assert.equal(checkBudget("free", { ...zero, answers: 100 }, "suggest"), null) // suggestions don't spend answers
  assert.equal(checkBudget("free", { ...zero, listening: 300 }, "suggest").code, "listening_limit")
  assert.equal(checkBudget("free", { ...zero, listening: 300 }, "answer"), null) // a question you ask still works
  assert.equal(checkBudget("free", { ...zero, vision: 10 }, "vision").code, "vision_limit")
  assert.equal(checkBudget("free", { ...zero, reports: 5 }, "report").code, "reports_limit")
})

test("a hands-free check needs answers and listening left", () => {
  assert.equal(checkBudget("free", { ...zero, listening: 300 }, "auto").code, "listening_limit")
  assert.equal(checkBudget("free", { ...zero, answers: 100 }, "auto").code, "answers_limit")
  assert.equal(checkBudget("free", zero, "auto"), null)
})

test("relabelling a task can't escape the token ceiling", () => {
  for (const task of ["answer", "auto", "vision", "suggest", "report"]) {
    assert.equal(checkBudget("free", { ...zero, tokens: PLANS.free.tokens }, task).code, "daily_limit")
  }
})

test("messages point free users to Pro and guests to updating", () => {
  assert.match(checkBudget("free", { ...zero, answers: 100 }, "answer").message, /100 free answers.*Upgrade to Pro/)
  assert.match(checkBudget("guest", { ...zero, answers: 20 }, "answer").message, /Update Meetingly and sign in/)
  assert.doesNotMatch(checkBudget("pro", { ...zero, answers: 1500 }, "answer").message, /Upgrade/)
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
