// Audio bookkeeping for the second pass (refine.ts): the speech worker keeps each channel's recent audio so a
// finished utterance can be transcribed again by a more accurate model. No Electron or native code here (tested).

export const SAMPLE_RATE = 16000

/** The last `capacity` samples of one channel (float, mono, 16 kHz), with a running count of all samples seen. */
export class AudioHistory {
  private readonly buf: Float32Array
  /** Samples pushed so far; sample i (counted from the start) lives at i % capacity while still kept. */
  total = 0

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity)
  }

  push(pcm: Float32Array): void {
    let src = pcm
    if (src.length > this.capacity) src = src.subarray(src.length - this.capacity)
    const at = (this.total + (pcm.length - src.length)) % this.capacity
    const first = Math.min(src.length, this.capacity - at)
    this.buf.set(src.subarray(0, first), at)
    if (first < src.length) this.buf.set(src.subarray(first), 0)
    this.total += pcm.length
  }

  /** Samples [start, end) as 16-bit PCM; the start moves up to the oldest sample still kept. */
  slice16(start: number, end: number): Int16Array {
    const from = Math.max(start, this.total - this.capacity, 0)
    const to = Math.min(end, this.total)
    const out = new Int16Array(Math.max(0, to - from))
    for (let i = 0; i < out.length; i++) {
      const v = this.buf[(from + i) % this.capacity]
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
    }
    return out
  }
}

/**
 * The samples of an utterance that just ended at `end`. The live model shows the first words about a second after
 * they were said, so the window opens `preRollMs` before that, but never earlier than shortly before the previous
 * utterance ended (its words must not come back). At most `maxMs` long (keeping the end).
 */
export function utteranceWindow(o: { end: number; prevEnd: number; firstText: number; preRollMs?: number; overlapMs?: number; maxMs?: number }): [number, number] {
  const ms = (n: number) => Math.round((n * SAMPLE_RATE) / 1000)
  const firstText = o.firstText >= 0 ? o.firstText : o.prevEnd
  let start = Math.max(firstText - ms(o.preRollMs ?? 2000), o.prevEnd - ms(o.overlapMs ?? 200), 0)
  start = Math.max(start, o.end - ms(o.maxMs ?? 29_500))
  return [Math.min(start, o.end), o.end]
}
