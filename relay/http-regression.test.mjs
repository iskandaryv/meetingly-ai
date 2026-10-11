import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
test("relay request validation, streaming and client cancellation with isolated providers", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetingly-relay-audit-"))
  let reached = false, disconnected = false
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/api/meetingly/entitlement") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ userId: "fixture", plan: "free" })); return }
    let raw = ""; for await (const chunk of req) raw += chunk
    const data = JSON.parse(raw)
    assert.ok(data.max_completion_tokens > 0)
    if (data.messages[0]?.content === "slow") {
      reached = true
      res.on("close", () => { disconnected = true })
      return
    }
    if (data.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
      setTimeout(() => res.end('data: [DONE]\n\n'), 30)
    } else { res.setHeader("content-type", "application/json"); res.end('{"choices":[{"message":{"content":"Hello"}}]}') }
  }).listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const probe = http.createServer().listen(0, "127.0.0.1"); await once(probe, "listening")
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ["relay.mjs"], { cwd: import.meta.dirname, windowsHide: true, stdio: "pipe", env: {
    ...process.env, APP_TOKEN: "audit-fixture-token", UPSTREAM_API_KEY: "audit-fixture-key", DEEPGRAM_API_KEY: "audit-unused",
    HOST: "127.0.0.1", PORT: String(port), ACCOUNT_URL: `http://127.0.0.1:${upstream.address().port}`,
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, INTERNAL_TOKEN: "", USAGE_FILE: path.join(dir, "usage.json")
  } })
  child.stdout.resume(); child.stderr.resume()
  try {
    let ready = false
    for (let i=0;i<100;i++) { try { ready=(await fetch(base+"/health")).ok } catch {} if(ready) break; await delay(30) }
    assert.ok(ready, "relay starts")
    const headers = { authorization: "Bearer audit-fixture-token", "x-device-id": "audit-device-001", "x-meetingly-account": "fixture-device", "x-meetingly-task": "answer", "content-type": "application/json" }
    assert.equal((await fetch(base+"/v1/chat/completions", { method:"POST", headers, body:"null" })).status,400)
    const response = await fetch(base+"/v1/chat/completions", { method:"POST", headers, body:JSON.stringify({ messages:[{role:"user",content:"hello"}],stream:true,max_tokens:-20 }) })
    assert.equal(response.status,200)
    const body=await response.text(); assert.match(body,/Hello/); assert.match(body,/DONE/)
    const controller = new AbortController()
    const pending = fetch(base+"/v1/chat/completions",{method:"POST",headers,body:JSON.stringify({messages:[{role:"user",content:"slow"}]}),signal:controller.signal}).catch(e=>e)
    for(let i=0;i<100&&!reached;i++) await delay(20)
    assert.ok(reached)
    controller.abort(); await pending
    for(let i=0;i<100&&!disconnected;i++) await delay(20)
    assert.ok(disconnected,"disconnect aborts provider before headers")
  } finally {
    child.kill(); await once(child,"exit")
    upstream.closeAllConnections(); await new Promise(resolve=>upstream.close(resolve))
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
