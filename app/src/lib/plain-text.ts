/**
 * An answer as plain text for pasting anywhere: bold and italic markers, code ticks and heading hashes
 * go, bullets become "- ", links become "text (url)". Code blocks are kept as they are, without fences.
 */
export function markdownToPlain(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    out.push(
      line
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/^(\s*)[*+]\s+/, "$1- ")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
    )
  }
  return out.join("\n").trim()
}
