import fs from "node:fs"
import path from "node:path"

/**
 * Per-device daily counters and per-IP rate limiting. Kept in memory and
 * flushed to a JSON file once a minute so restarts do not reset the day.
 */
export class Quotas {
  constructor({ file, chatPerDay, answersPerDay = Infinity, audioMinutesPerDay, requestsPerMinutePerIp, now = () => Date.now() }) {
    this.file = file
    this.chatPerDay = chatPerDay
    this.answersPerDay = answersPerDay
    this.audioMinutesPerDay = audioMinutesPerDay
    this.rpm = requestsPerMinutePerIp
    this.now = now
    this.ipHits = new Map() // ip -> timestamps within the last minute
    this.days = this.load()
    this.timer = setInterval(() => this.flush(), 60_000)
    this.timer.unref?.()
  }

  allowRequest(ip) {
    const t = this.now()
    const hits = (this.ipHits.get(ip) ?? []).filter((x) => t - x < 60_000)
    hits.push(t)
    this.ipHits.set(ip, hits)
    if (this.ipHits.size > 10_000) this.ipHits.clear()
    return hits.length <= this.rpm
  }

  allowChat(device) {
    return this.entry(device).chat < this.chatPerDay
  }

  countChat(device) {
    this.entry(device).chat += 1
  }

  /** The free daily answer limit; every request still counts toward the chat cap above. */
  allowAnswer(device) {
    return (this.entry(device).answers ?? 0) < this.answersPerDay
  }

  countAnswer(device) {
    const e = this.entry(device)
    e.answers = (e.answers ?? 0) + 1
  }

  allowAudio(device) {
    return this.entry(device).audioMinutes < this.audioMinutesPerDay
  }

  countAudio(device, minutes) {
    this.entry(device).audioMinutes += Math.max(0, minutes)
  }

  usage(device) {
    const e = this.entry(device)
    return { chat: e.chat, chatLimit: this.chatPerDay, answers: e.answers ?? 0, answersLimit: this.answersPerDay, audioMinutes: Math.round(e.audioMinutes), audioLimit: this.audioMinutesPerDay }
  }

  entry(device) {
    const day = this.dayKey()
    if (!this.days[day]) this.days = { [day]: {} } // new day: drop yesterday
    const bucket = this.days[day]
    if (!bucket[device]) bucket[device] = { chat: 0, answers: 0, audioMinutes: 0 }
    return bucket[device]
  }

  dayKey() {
    return new Date(this.now()).toISOString().slice(0, 10)
  }

  load() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, "utf8"))
        return typeof data === "object" && data ? data : {}
      }
    } catch (err) {
      console.warn("[quotas] could not read usage file:", err.message)
    }
    return {}
  }

  flush() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.days))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.warn("[quotas] could not write usage file:", err.message)
    }
  }
}
