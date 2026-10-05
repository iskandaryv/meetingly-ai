import { createHash } from "node:crypto"

/**
 * Who is calling: the app sends its device token, the account service (account.meetinglyai.com, on this
 * box) says which user and plan it belongs to. Answers are cached so the account service sees one
 * lookup per account every few minutes, not one per request.
 */
export class Accounts {
  constructor({ baseUrl = "http://127.0.0.1:8091", fetch = globalThis.fetch, now = () => Date.now(), ttlMs = 5 * 60_000, errorTtlMs = 30_000, maxEntries = 50_000 } = {}) {
    this.baseUrl = baseUrl
    this.fetch = fetch
    this.now = now
    this.ttlMs = ttlMs
    this.errorTtlMs = errorTtlMs
    this.maxEntries = maxEntries
    this.cache = new Map() // sha256(token) -> { value, expires }
  }

  /**
   * { ok: true, userId, plan } for a valid token, { ok: false } for a rejected one.
   * Throws only when the account service can't be reached and nothing is cached for this token.
   */
  async resolve(token) {
    const key = createHash("sha256").update(token).digest("hex")
    const hit = this.cache.get(key)
    const t = this.now()
    if (hit && hit.expires > t) return hit.value

    let res
    try {
      res = await this.fetch(`${this.baseUrl}/api/meetingly/entitlement`, { headers: { Authorization: token }, signal: AbortSignal.timeout(5000) })
    } catch (err) {
      if (hit) return hit.value // stale beats refusing everyone while the account service restarts
      throw err
    }
    let value
    if (res.status === 200) {
      const body = await res.json()
      value = { ok: true, userId: String(body.userId), plan: body.plan === "pro" || body.plan === "unlimited" ? body.plan : "free" }
    } else if (res.status === 401 || res.status === 403 || res.status === 404) {
      value = { ok: false }
    } else {
      if (hit) return hit.value
      throw new Error(`account service HTTP ${res.status}`)
    }
    this.remember(key, value, t + (value.ok ? this.ttlMs : this.errorTtlMs))
    return value
  }

  remember(key, value, expires) {
    if (this.cache.size >= this.maxEntries) {
      const t = this.now()
      for (const [k, v] of this.cache) if (v.expires <= t) this.cache.delete(k)
      if (this.cache.size >= this.maxEntries) this.cache.clear()
    }
    this.cache.set(key, { value, expires })
  }
}
