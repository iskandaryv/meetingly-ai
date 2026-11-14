/** A stable separator lets the UI show the two versions without changing normal answers. */
export const SPOKEN_MARKER = "[[SPOKEN]]"

export function splitAnswerVariants(text: string): { standard: string; spoken: string | null } {
  const match = /(?:^|\r?\n)[ \t]*\[\[SPOKEN\]\][ \t]*(?:\r?\n|$)/.exec(text)
  if (match) {
    const spoken = text.slice(match.index + match[0].length).trim()
    return { standard: text.slice(0, match.index).trimEnd(), spoken: spoken || null }
  }
  // Streaming can split the marker across chunks. Hold its incomplete last line back.
  const lineStart = text.lastIndexOf("\n") + 1
  const tail = text.slice(lineStart).trim()
  if (tail && SPOKEN_MARKER.startsWith(tail)) {
    return { standard: text.slice(0, lineStart).trimEnd(), spoken: null }
  }
  return { standard: text, spoken: null }
}
