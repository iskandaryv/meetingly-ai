import { test } from "node:test"
import assert from "node:assert/strict"
import { modelConfig, modelsFor, upstreamFor } from "./models.mjs"

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

test("plans get their own models; a task override wins over the plan, a plan+task override over both", () => {
  const config = modelConfig({
    DEFAULT_MODEL: "gpt-5.6-luna",
    FALLBACK_MODEL: "gpt-5.5",
    MODEL_PRO: "claude-sonnet-x",
    MODEL_UNLIMITED: "claude-opus-x",
    FALLBACK_MODEL_UNLIMITED: "gpt-6",
    MODEL_SUGGEST: "gpt-5.6-luna",
    MODEL_UNLIMITED_VISION: "gpt-6"
  })
  assert.deepEqual(modelsFor(config, "answer", "free"), ["gpt-5.6-luna", "gpt-5.5"])
  assert.deepEqual(modelsFor(config, "answer", "pro"), ["claude-sonnet-x", "gpt-5.5"])
  assert.deepEqual(modelsFor(config, "answer", "unlimited"), ["claude-opus-x", "gpt-6"])
  assert.deepEqual(modelsFor(config, "suggest", "unlimited"), ["gpt-5.6-luna", "gpt-6"])
  assert.deepEqual(modelsFor(config, "vision", "unlimited"), ["gpt-6"])
  assert.deepEqual(modelsFor(config, "answer"), ["gpt-5.6-luna", "gpt-5.5"])
})

test("claude models go to the Claude gateway when there is one", () => {
  const main = { base: "https://main/v1", key: "a" }
  const claude = { base: "https://claude/v1", key: "b" }
  assert.equal(upstreamFor("claude-sonnet-x", { main, claude }), claude)
  assert.equal(upstreamFor("gpt-6", { main, claude }), main)
  assert.equal(upstreamFor("claude-sonnet-x", { main, claude: null }), main)
})
