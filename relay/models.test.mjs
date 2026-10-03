import { test } from "node:test"
import assert from "node:assert/strict"
import { modelConfig, modelsFor } from "./models.mjs"

test("one default model for every task, then the fallback", () => {
  const config = modelConfig({ DEFAULT_MODEL: "gpt-5.6-luna", FALLBACK_MODEL: "gpt-5.5" })
  for (const task of ["answer", "suggest", "vision", "report"]) assert.deepEqual(modelsFor(config, task), ["gpt-5.6-luna", "gpt-5.5"])
})

test("a task can be moved to another model on its own", () => {
  const config = modelConfig({ DEFAULT_MODEL: "gpt-5.6-luna", FALLBACK_MODEL: "gpt-5.5", MODEL_SUGGEST: " gpt-6-luna " })
  assert.deepEqual(modelsFor(config, "suggest"), ["gpt-6-luna", "gpt-5.5"])
  assert.deepEqual(modelsFor(config, "answer"), ["gpt-5.6-luna", "gpt-5.5"])
})

test("old builds without a task, or an unknown task, get the default", () => {
  const config = modelConfig({ DEFAULT_MODEL: "gpt-5.6-luna", FALLBACK_MODEL: "gpt-5.5", MODEL_SUGGEST: "gpt-6-luna" })
  assert.deepEqual(modelsFor(config, ""), ["gpt-5.6-luna", "gpt-5.5"])
  assert.deepEqual(modelsFor(config, "toString"), ["gpt-5.6-luna", "gpt-5.5"])
})

test("no fallback configured, or the fallback is the same model: one attempt", () => {
  assert.deepEqual(modelsFor(modelConfig({ DEFAULT_MODEL: "gpt-5.6-luna" }), "answer"), ["gpt-5.6-luna"])
  assert.deepEqual(modelsFor(modelConfig({ DEFAULT_MODEL: "gpt-5.5", FALLBACK_MODEL: "gpt-5.5" }), "answer"), ["gpt-5.5"])
  assert.deepEqual(modelsFor(modelConfig({}), "answer"), ["gpt-5.6-luna"])
})
