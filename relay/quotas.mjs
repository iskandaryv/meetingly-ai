import fs from "node:fs"
import path from "node:path"

const FIELDS = ["requests", "answers", "vision", "listening", "reports", "tokens", "audioMinutes"]

/**
 * Daily counters per key ("u:<userId>" for accounts, "ip:<ip>" for guests, "ipa:<ip>" for the
 * per-network answer total), requests in flight per key, and per-IP rate limiting. Counters live in
 * memory and are flushed to a JSON file once a minute so restarts do not reset the day.
 */
export class Quotas {
  /** Completed days remain durable until onRollover resolves successfully (false means retry). */
  constructor({ file, requestsPerMinutePerIp, now = () => Date.now(), onRollover = null }) {
    this.file = file
    this.onRollover = onRollover
    this.rpm = requestsPerMinutePerIp
    this.now = now
    this.ipHits = new Map() // ip -> timestamps within the last minute
    this.keyHits = new Map() // account key -> timestamps within the last minute
    this.flight = new Map() // key -> requests in progress
    this.days = this.load()
    this.delivering = new Set()
    this.retryAt = new Map()
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
    // Denied requests must not grow the timestamp list or extend it indefinitely.
    const allowed = hits.length < limit
    if (allowed) hits.push(t)
    map.set(id, hits)
    if (map.size > 20_000) {
      // Forget quiet callers instead of resetting everyone.
      for (const [k, v] of map) if (!v.length || t - v[v.length - 1] >= 60_000) map.delete(k)
    }
    return allowed
  }

  /** Today's counters for a key (zeros when unseen; reading never creates an entry). */
  used(key) {
    const bucket = this.days[this.dayKey()]
    const e = bucket?.[key]
    return Object.fromEntries(FIELDS.map((f) => [f, e?.[f] ?? 0]))
  }

  /** A request refused by a limit (answers_limit, rate_limit, …), for the owner's abuse view. */
  noteLimit(key, code) {
    if (!key) return
    const e = this.entry(key)
    e.limits = e.limits ?? {}
    e.limits[code] = (e.limits[code] ?? 0) + 1
  }

  /** Today's counters for every caller (not the per-network totals), as the account service stores them. */
  snapshot() {
    const day = this.rollover()
    return { day, keys: Object.fromEntries(Object.entries(this.days[day] ?? {}).filter(([k]) => !k.startsWith("ipa:"))) }
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
    const day = this.rollover()
    const bucket = this.days[day]
    if (!bucket[key]) bucket[key] = {}
    return bucket[key]
  }

  rollover() {
    const day = this.dayKey()
    this.days[day] ??= {}
    for (const [old, keys] of Object.entries(this.days)) {
      if (old >= day) continue
      if (!this.onRollover) { delete this.days[old]; continue }
      if (this.delivering.has(old) || this.now() < (this.retryAt.get(old) ?? 0)) continue
      // Persist the final counters before attempting delivery, so a restart can retry them.
      this.persist()
      this.delivering.add(old)
      let delivery
      try { delivery = this.onRollover(old, Object.fromEntries(Object.entries(keys).filter(([k]) => !k.startsWith("ipa:")))) }
      catch (error) { delivery = Promise.reject(error) }
      Promise.resolve(delivery).then(ok => {
        if (ok === false) { this.retryAt.set(old, this.now() + 60_000); return }
        delete this.days[old]
        this.retryAt.delete(old)
        this.persist()
      }).catch(error => {
        this.retryAt.set(old, this.now() + 60_000)
        console.warn("[quotas] rollover:", error.message)
      }).finally(() => this.delivering.delete(old))
    }
    return day
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
    this.rollover()
    this.persist()
  }

  persist() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.days), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.warn("[quotas] could not write usage file:", err.message)
    }
  }
}
