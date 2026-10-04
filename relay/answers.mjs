// A reply passing through the relay is watched for two things: what it was (a real answer, the skip
// marker of a hands-free check that answered nothing, or empty) and how many tokens it used.

export const SKIP_TOKEN = "[no-answer]"

/** Watches a reply as it passes through (SSE when streamed, JSON otherwise). */
export class ReplyWatcher {
  constructor(streamed) {
    this.streamed = streamed
    this.pending = ""
    this.start = ""
    this.raw = ""
    this.usage = 0
  }

  push(chunk) {
    if (!this.streamed) {
      if (this.raw.length < 1_000_000) this.raw += chunk
      return
    }
    this.pending += chunk
    const lines = this.pending.split("\n")
    this.pending = lines.pop()
    for (const line of lines) this.line(line)
  }

  /** "answer", "skip", or "empty" when no text came back. */
  verdict() {
    this.finish()
    const t = this.start.replace(/^[\s*_`]+/, "")
    if (!t) return "empty"
    return t.startsWith(SKIP_TOKEN) ? "skip" : "answer"
  }

  /** Total tokens the upstream reported (0 when it didn't). */
  tokens() {
    this.finish()
    return this.usage
  }

  finish() {
    if (this.done) return
    this.done = true
    if (this.streamed) {
      if (this.pending) this.line(this.pending)
      this.pending = ""
      return
    }
    try {
      const body = JSON.parse(this.raw)
      this.start = body.choices?.[0]?.message?.content ?? ""
      this.usage = Number(body.usage?.total_tokens) || 0
    } catch {
      this.start = ""
    }
  }

  line(line) {
    const l = line.trim()
    if (!l.startsWith("data:")) return
    try {
      const chunk = JSON.parse(l.slice(5))
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta && this.start.length < 64) this.start += delta
      if (chunk.usage?.total_tokens) this.usage = Number(chunk.usage.total_tokens) || this.usage
    } catch {
      // "[DONE]" and keep-alives
    }
  }
}
