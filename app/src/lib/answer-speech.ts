/** Local speech playback with an acknowledged, renewable recording-suppression lease. */
export class AnswerSpeech {
  private utterance: SpeechSynthesisUtterance | null = null
  private renewal: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly setActive: (playing: boolean) => Promise<void>,
    private readonly changed: (id: string | null, error: boolean) => void
  ) {}

  stop(): void {
    const active = this.utterance !== null
    this.utterance = null
    if (this.renewal) clearInterval(this.renewal)
    this.renewal = null
    window.speechSynthesis?.cancel()
    if (active) void this.setActive(false).catch(() => {})
    this.changed(null, false)
  }

  async play(id: string, text: string, language: string): Promise<void> {
    this.stop()
    if (!text.trim()) return
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      this.changed(null, true)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = language === "zh" ? "zh-CN" : language
    utterance.rate = 1.1
    this.utterance = utterance
    this.changed(id, false)
    const finish = (error: boolean) => {
      if (this.utterance !== utterance) return
      this.stop()
      this.changed(null, error)
    }
    utterance.onend = () => finish(false)
    utterance.onerror = () => finish(true)
    try {
      // No audible output until the main process acknowledges capture suppression.
      await this.setActive(true)
      if (this.utterance !== utterance) return
      this.renewal = setInterval(() => {
        void this.setActive(true).catch(() => finish(true))
      }, 10000)
      window.speechSynthesis.speak(utterance)
    } catch {
      finish(true)
    }
  }
}
