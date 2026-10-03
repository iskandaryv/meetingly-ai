// The free daily answer limit counts real answers only. A hands-free check that ends in the skip
// marker ("[no-answer]", possibly wrapped in markdown) answered nothing, so it is not counted.

export const SKIP_TOKEN = "[no-answer]"

/** Tasks that produce an answer for the user. "" = builds that send no task (1.0.0), which only ask for answers. */
export const ANSWER_TASKS = new Set(["answer", "vision", ""])

/** Watches a reply as it passes through (SSE when streamed, JSON otherwise) and tells what it was. */
export class ReplyWatcher {
  constructor(streamed) {
    this.streamed = streamed
    this.pending = ""
    this.start = ""
    this.raw = ""
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
    let text = this.start
    if (this.streamed) {
      if (this.pending) this.line(this.pending)
      this.pending = ""
      text = this.start
    } else {
      try {
        text = JSON.parse(this.raw).choices?.[0]?.message?.content ?? ""
      } catch {
        text = ""
      }
    }
    const t = text.replace(/^[\s*_`]+/, "")
    if (!t) return "empty"
    return t.startsWith(SKIP_TOKEN) ? "skip" : "answer"
  }

  line(line) {
    const l = line.trim()
    if (!l.startsWith("data:") || this.start.length >= 64) return
    try {
      const delta = JSON.parse(l.slice(5)).choices?.[0]?.delta?.content
      if (delta) this.start += delta
    } catch {
      // "[DONE]" and keep-alives
    }
  }
}
