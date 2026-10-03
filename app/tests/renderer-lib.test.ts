import { describe, expect, it } from "vitest"
import { formatDuration, formatWhen, truncate } from "../src/lib/format"
import { renderMarkdown } from "../src/lib/markdown"

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(5000)).toBe("5s")
    expect(formatDuration(65000)).toBe("1:05")
    expect(formatDuration(3723000)).toBe("1:02:03")
    expect(formatDuration(-1)).toBe("0s")
  })
})

describe("formatWhen", () => {
  it("shows a time for today and a date otherwise", () => {
    const now = new Date(2026, 8, 17, 15, 0).getTime()
    expect(formatWhen(now - 60_000, now)).toMatch(/\d{1,2}:\d{2}/)
    expect(formatWhen(now - 3 * 86_400_000, now)).toMatch(/Sep/)
  })
})

describe("truncate", () => {
  it("adds an ellipsis only when needed", () => {
    expect(truncate("short", 10)).toBe("short")
    expect(truncate("a long sentence here", 8)).toBe("a long…")
  })
})

describe("renderMarkdown", () => {
  it("escapes html from the model", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>")
  })
  it("renders a bold answer line directly followed by catch points", () => {
    const html = renderMarkdown("**Kafka is a distributed log.**\n- topics and partitions\n- consumers read at their own pace\n\nMore detail here.")
    expect(html).toBe("<p><strong>Kafka is a distributed log.</strong></p><ul><li>topics and partitions</li><li>consumers read at their own pace</li></ul><p>More detail here.</p>")
  })
  it("renders numbered lists, also right after a line", () => {
    expect(renderMarkdown("Steps:\n1. measure\n2) fix")).toBe("<p>Steps:</p><ol><li>measure</li><li>fix</li></ol>")
  })
  it("renders bold, inline code, lists and fenced code", () => {
    const html = renderMarkdown("**bold** and `code`\n\n- one\n- two\n\n```js\nlet a = 1 < 2\n```")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>code</code>")
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>")
    expect(html).toContain("<pre><code>let a = 1 &lt; 2</code></pre>")
  })
})
