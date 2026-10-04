import { test } from "node:test"
import assert from "node:assert/strict"
import { ReplyWatcher } from "./answers.mjs"

const sse = (...deltas) => deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join("") + "data: [DONE]\n\n"

function watch(streamed, body, chunkSize = 7) {
  const w = new ReplyWatcher(streamed)
  for (let i = 0; i < body.length; i += chunkSize) w.push(body.slice(i, i + chunkSize)) // split mid-line on purpose
  return w.verdict()
}

test("a streamed answer counts, even when the stream is cut into odd pieces", () => {
  assert.equal(watch(true, sse("**Kafka is ", "a distributed log.**", "\n- topics")), "answer")
})

test("the skip marker is not an answer, also in bold or split across chunks", () => {
  assert.equal(watch(true, sse("[no-", "answer]")), "skip")
  assert.equal(watch(true, sse("**[no-answer]**")), "skip")
  assert.equal(watch(true, sse("  ", "[no-answer]")), "skip")
})

test("non-streamed replies are read from the JSON body", () => {
  const body = (content) => JSON.stringify({ choices: [{ message: { content } }] })
  assert.equal(watch(false, body("It prints 6.67, the loop skips the first item.")), "answer")
  assert.equal(watch(false, body("[no-answer]")), "skip")
  assert.equal(watch(false, "not json"), "empty")
})

test("nothing back is not an answer", () => {
  assert.equal(watch(true, "data: [DONE]\n\n"), "empty")
})

test("token usage is read from the last SSE chunk and from JSON bodies", () => {
  const streamed = new ReplyWatcher(true)
  const body = sse("Hello") + `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 321 } })}

data: [DONE]

`
  for (let i = 0; i < body.length; i += 5) streamed.push(body.slice(i, i + 5))
  assert.equal(streamed.tokens(), 321)
  assert.equal(streamed.verdict(), "answer")
  const plain = new ReplyWatcher(false)
  plain.push(JSON.stringify({ choices: [{ message: { content: "Hi" } }], usage: { total_tokens: 77 } }))
  assert.equal(plain.tokens(), 77)
})
