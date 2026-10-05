import fs from "node:fs"
import path from "node:path"

const FIELDS = ["requests", "answers", "vision", "listening", "reports", "tokens", "audioMinutes"]

/**
 * Daily counters per key ("u:<userId>" for accounts, "ip:<ip>" for guests, "ipa:<ip>" for the
 * per-network answer total), requests in flight per key, and per-IP rate limiting. Counters live in
 * memory and are flushed to a JSON file once a minute so restarts do not reset the day.
 */
export class Quotas {
  constructor({ file, requestsPerMinutePerIp, now = () => Date.now() }) {
    this.file = file
    this.rpm = requestsPerMinutePerIp
    this.now = now
    this.ipHits = new Map() // ip -> timestamps within the last minute
    this.keyHits = new Map() // account key -> timestamps within the last minute
    this.flight = new Map() // key -> requests in progress
    this.days = this.load()
    this.timer = setInterval(() => this.flush(), 60_000)
    this.timer.unref?.()
  }

  /** Sliding one-minute window per IP. */
  allowRequest(ip) {
    return this.slide(this.ipHits, ip, this.rpm)
  }

  /** Sliding one-minute window per account (the plan's requests per minute). */
  allowKey(key, rpm) {
    return this.slide(this.keyHits, key, rpm)
  }

  slide(map, id, limit) {
    const t = this.now()
    const hits = (map.get(id) ?? []).filter((x) => t - x < 60_000)
    hits.push(t)
    map.set(id, hits)
    if (map.size > 20_000) {
      // Forget quiet callers instead of resetting everyone.
      for (const [k, v] of map) if (!v.length || t - v[v.length - 1] >= 60_000) map.delete(k)
    }
    return hits.length <= limit
  }

  /** Today's counters for a key (zeros when unseen; reading never creates an entry). */
  used(key) {
    const bucket = this.days[this.dayKey()]
    const e = bucket?.[key]
    return Object.fromEntries(FIELDS.map((f) => [f, e?.[f] ?? 0]))
  }

  add(key, field, amount = 1) {
    if (!(amount > 0)) return
    const e = this.entry(key)
    e[field] = (e[field] ?? 0) + amount
  }

  inFlight(key) {
    return this.flight.get(key) ?? 0
  }

  begin(key) {
    this.flight.set(key, this.inFlight(key) + 1)
  }

  end(key) {
    const n = this.inFlight(key) - 1
    if (n > 0) this.flight.set(key, n)
    else this.flight.delete(key)
  }

  /** When today's counters reset (next midnight UTC). */
  resetAt() {
    const d = new Date(this.now())
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
  }

  entry(key) {
    const day = this.dayKey()
    if (!this.days[day]) this.days = { [day]: {} } // new day: drop yesterday
    const bucket = this.days[day]
    if (!bucket[key]) bucket[key] = {}
    return bucket[key]
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
