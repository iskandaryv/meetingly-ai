// Finished utterances waiting for their second pass (refine.ts). No Electron here (tested).

export interface FinalText {
  channel: number
  text: string
  speechFinal: boolean
}

interface Waiting {
  final: FinalText
  timer: ReturnType<typeof setTimeout>
}

/**
 * Holds each finished utterance until the refine model has written it again, then hands on the better text (or the
 * live model's, when the second pass fails, comes back empty or takes longer than `timeoutMs`). Utterances leave in
 * the order they came: when too many wait, the oldest go on as they are.
 */
export class RefineQueue {
  private readonly waiting = new Map<number, Waiting>()
  private nextId = 1

  constructor(
    private readonly emit: (final: FinalText, refined: boolean) => void,
    private readonly timeoutMs = 8000,
    private readonly maxWaiting = 4
  ) {}

  /** Starts waiting for an utterance; returns the id its second pass reports back with. */
  hold(final: FinalText): number {
    while (this.waiting.size >= this.maxWaiting) this.release(this.waiting.keys().next().value!, null)
    const id = this.nextId++
    this.waiting.set(id, { final, timer: setTimeout(() => this.release(id, null), this.timeoutMs) })
    return id
  }

  /** The second pass for `id` is done (`text` empty when it failed). Unknown ids (timed out) are ignored. */
  resolve(id: number, text: string): void {
    this.release(id, text.trim() || null)
  }

  /** Text still waiting on a channel, oldest first: shown in front of that channel's live words meanwhile. */
  waitingText(channel: number): string {
    return [...this.waiting.values()].filter((w) => w.final.channel === channel).map((w) => w.final.text).join(" ")
  }

  get size(): number {
    return this.waiting.size
  }

  /** Everything waiting goes on now, as the live model wrote it (stopping, or the second pass went away). */
  flush(): void {
    for (const id of [...this.waiting.keys()]) this.release(id, null)
  }

  private release(id: number, text: string | null): void {
    const w = this.waiting.get(id)
    if (!w) return
    clearTimeout(w.timer)
    // Older utterances on the same channel go first, so a channel's lines never swap places.
    for (const [older, o] of this.waiting) {
      if (older >= id) break
      if (o.final.channel === w.final.channel) this.release(older, null)
    }
    this.waiting.delete(id)
    this.emit(text ? { ...w.final, text } : w.final, Boolean(text))
  }
}
