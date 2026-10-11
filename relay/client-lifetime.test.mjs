import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { clientLifetime } from "./client-lifetime.mjs"

test("disconnect before upstream headers aborts provider work", () => {
  const response = new EventEmitter()
  response.writableFinished = false
  const client = clientLifetime(response)
  response.emit("close")
  assert.equal(client.signal.aborted, true)
  client.dispose()
  assert.equal(response.listenerCount("close"), 0)
})

test("normal response completion does not abort completed work", () => {
  const response = new EventEmitter()
  response.writableFinished = true
  const client = clientLifetime(response)
  response.emit("close")
  assert.equal(client.signal.aborted, false)
  client.dispose()
})
