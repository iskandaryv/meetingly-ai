import { EventEmitter } from "node:events"
import os from "node:os"
import { EventSource } from "eventsource"
import { CLOUD_SETTING_KEYS, cloudUrl, type CloudAccount, type CloudState } from "../../shared/cloud"
import type { Meeting, Prompt, Settings } from "../../shared/types"
import type { MeetingStore } from "./meetings"
import type { SettingsStore } from "./settings"
import { t } from "../../shared/i18n"

interface Deps {
  settings: SettingsStore
  meetings: MeetingStore
  appVersion: string
  openExternal: (url: string) => Promise<void>
  cloudUrl?: string
}

type CloudSettings = Partial<Pick<Settings, (typeof CLOUD_SETTING_KEYS)[number]>>

interface ProfileRecord {
  id: string
  settings: CloudSettings | null
  version: number
}

interface PromptRecord {
  id: string
  title: string
  content: string
  notes: string
  active: boolean
  position: number
}

interface MeetingRecord {
  id: string
  localId: string
  title: string
  startTime: number
  endTime: number
  duration: number
  language: string
  status: Meeting["status"]
  transcript: Meeting["transcript"]
  fullTranscriptText: string
  summary: Meeting["summary"] | null
  created: string
  updated: string
}

interface MeetingsPage {
  items: MeetingRecord[]
  index: { id: string; localId: string; updated: string }[]
  syncedAt: string
}

/** An answer from the account service other than 2xx. */
class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const POLL_MS = 2000
const LINK_TIMEOUT_MS = 10 * 60 * 1000
const PUSH_DEBOUNCE_MS = 800
const RECONCILE_MS = 5 * 60 * 1000
const RETRY_MS = [5_000, 15_000, 30_000, 60_000]

/**
 * Keeps this device in step with the user's account (account.meetinglyai.com): settings and prompts in
 * both directions, meetings uploaded, and changes from other devices and the web dashboard applied live
 * over an event stream. Losing the connection retries on its own; every reconnect reconciles.
 *
 * Events: "state" (CloudState)
 */
export class CloudSync extends EventEmitter {
  private online = false
  private status: CloudState["status"] = "off"
  private error: string | undefined
  private lastSync: number | undefined
  private linking: { code: string; url: string; timer: NodeJS.Timeout; deadline: number } | null = null
  private events: EventSource | null = null
  private applyingRemote = false
  private pushTimer: NodeJS.Timeout | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retries = 0
  /** The settings as the server last had them (JSON), so unchanged settings aren't uploaded. */
  private serverSettingsJson: string | null = null
  private lastPromptsJson = ""
  /** The server's `updated` time per meeting (by local id); a local copy edited after it gets uploaded. */
  private remoteUpdated = new Map<string, number>()
  private meetingsSince: string | undefined

  constructor(private readonly deps: Deps) {
    super()
    deps.settings.onChange((_s, origin) => {
      if (origin === "cloud" || !this.online) return
      this.schedulePush()
    })
    deps.meetings.on("changed", () => {
      if (this.online) this.schedulePush()
    })
  }

  state(): CloudState {
    const account = this.deps.settings.get().cloud
    return {
      status: this.status,
      email: account?.email,
      code: this.linking?.code,
      linkUrl: this.linking?.url,
      lastSync: this.lastSync,
      error: this.error
    }
  }

  /** Called once at startup: reconnect if an account is linked. */
  async start(): Promise<void> {
    const account = this.deps.settings.get().cloud
    if (!account) return
    await this.connect(account)
  }

  async linkStart(): Promise<CloudState> {
    if (this.linking) return this.state()
    const base = cloudUrl(this.deps.cloudUrl)
    const res = await fetch(`${base}/api/app/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: this.deps.settings.deviceId(), name: os.hostname(), platform: process.platform, appVersion: this.deps.appVersion })
    })
    if (!res.ok) throw new Error(t("Account service unavailable (HTTP {status})", { status: res.status }))
    const { code, url } = (await res.json()) as { code: string; url: string }

    this.setStatus("linking")
    const timer = setInterval(() => void this.pollLink(), POLL_MS)
    this.linking = { code, url, timer, deadline: Date.now() + LINK_TIMEOUT_MS }
    this.emitState()
    await this.deps.openExternal(url)
    return this.state()
  }

  linkCancel(): CloudState {
    this.stopLinking()
    this.setStatus(this.deps.settings.get().cloud ? "offline" : "off")
    return this.state()
  }

  async unlink(): Promise<CloudState> {
    this.stopLinking()
    this.disconnect()
    // Best effort: revoke this device's token on the account.
    if (this.deps.settings.get().cloud) await this.api("DELETE", "/api/app/device").catch(() => undefined)
    this.forget("off")
    return this.state()
  }

  /** Open the web dashboard, signed in when this device is linked; `page` is "billing" for the plan page. */
  async openWeb(page = ""): Promise<void> {
    const base = cloudUrl(this.deps.cloudUrl || this.deps.settings.get().cloud?.url)
    const next = page === "billing" ? "/dashboard/plan" : "/dashboard"
    if (!this.deps.settings.get().cloud) return this.deps.openExternal(`${base}${next}`)
    try {
      const { url } = await this.api<{ url: string }>("POST", "/api/app/web-login", { next })
      await this.deps.openExternal(url)
    } catch {
      // Not reachable right now: the plain page, which asks to sign in.
      await this.deps.openExternal(`${base}${next}`)
    }
  }

  async syncNow(): Promise<CloudState> {
    const account = this.deps.settings.get().cloud
    if (!account) return this.state()
    if (this.online) await this.reconcile().catch((err) => this.fail(err))
    else await this.connect(account)
    return this.state()
  }

  /** A meeting deleted in this app is deleted on the account (and so on the user's other devices) too. */
  async meetingDeleted(localId: string): Promise<void> {
    this.remoteUpdated.delete(localId)
    if (!this.online) return
    await this.api("DELETE", `/api/app/meetings/${encodeURIComponent(localId)}`).catch((err) => console.warn("[cloud] meeting delete failed:", (err as Error).message))
  }

  // ---------------------------------------------------------------- linking

  private async pollLink(): Promise<void> {
    const link = this.linking
    if (!link) return
    if (Date.now() > link.deadline) {
      this.stopLinking()
      this.error = t("The code expired before the browser confirmed it.")
      this.setStatus(this.deps.settings.get().cloud ? "offline" : "off")
      return
    }
    try {
      const base = cloudUrl(this.deps.cloudUrl)
      const res = await fetch(`${base}/api/app/link/poll?code=${link.code}&deviceId=${this.deps.settings.deviceId()}`)
      if (!res.ok) return
      const body = (await res.json()) as { pending: boolean; expired?: boolean; token?: string; user?: { id: string; email: string; name?: string } }
      if (body.pending) return
      this.stopLinking()
      if (body.expired || !body.token || !body.user) {
        this.error = t("The code expired. Start again.")
        this.setStatus(this.deps.settings.get().cloud ? "offline" : "off")
        return
      }
      const account: CloudAccount = { url: base, token: body.token, userId: body.user.id, email: body.user.email, name: body.user.name, linkedAt: Date.now() }
      // Uploaded copies may belong to another account (or an older server): match meetings by their local
      // id again, so none is mistaken for "deleted on the account" and dropped.
      for (const m of this.deps.meetings.list()) if (m.remoteId) this.deps.meetings.save({ ...m, remoteId: undefined }, true)
      this.deps.settings.update({ cloud: account }, "cloud")
      await this.connect(account)
    } catch (err) {
      console.warn("[cloud] link poll failed:", (err as Error).message)
    }
  }

  private stopLinking(): void {
    if (this.linking) clearInterval(this.linking.timer)
    this.linking = null
  }

  // ------------------------------------------------------------- connection

  private base(): string {
    return cloudUrl(this.deps.cloudUrl || this.deps.settings.get().cloud?.url)
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.deps.settings.get().cloud?.token
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    })
    const data = (await res.json().catch(() => ({}))) as T & { message?: string }
    if (!res.ok) throw new CloudError(res.status, data?.message || t("Account service unavailable (HTTP {status})", { status: res.status }))
    return data
  }

  private async connect(account: CloudAccount): Promise<void> {
    this.disconnect()
    try {
      const me = await this.api<{ linked: boolean; user: { email: string; name?: string } }>(
        "GET",
        `/api/app/me?deviceId=${this.deps.settings.deviceId()}&appVersion=${encodeURIComponent(this.deps.appVersion)}`
      )
      if (!me.linked) return this.signedOut(t("This device was disconnected from the account in the web dashboard."))
      if (me.user.email !== account.email) this.deps.settings.update({ cloud: { ...account, email: me.user.email, name: me.user.name } }, "cloud")
      await this.reconcile()
      this.openEvents()
      this.reconcileTimer = setInterval(() => void this.reconcile().catch((err) => this.fail(err)), RECONCILE_MS)
      this.online = true
      this.retries = 0
      this.error = undefined
      this.setStatus("online")
    } catch (err) {
      if (err instanceof CloudError && err.status === 401) return this.signedOut(t("Signed out on the server. Connect the account again."))
      this.fail(err)
    }
  }

  /** The account no longer accepts this device: drop the link, keep everything local. */
  private signedOut(message: string): void {
    this.disconnect()
    this.error = message
    this.forget("off")
  }

  private forget(status: CloudState["status"]): void {
    this.online = false
    this.serverSettingsJson = null
    this.lastPromptsJson = ""
    this.remoteUpdated.clear()
    this.meetingsSince = undefined
    this.deps.settings.update({ cloud: null }, "cloud")
    this.setStatus(status)
  }

  private disconnect(): void {
    this.online = false
    this.events?.close()
    this.events = null
    for (const timer of [this.reconcileTimer, this.retryTimer]) if (timer) clearInterval(timer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.reconcileTimer = this.retryTimer = this.pushTimer = null
  }

  /** Live changes from the account. The stream reconnects by itself; each reconnect reconciles. */
  private openEvents(): void {
    const token = this.deps.settings.get().cloud?.token
    const es = new EventSource(`${this.base()}/api/app/events`, {
      fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } })
    })
    let opened = false
    const on = <T>(type: string, handle: (data: T) => void) =>
      es.addEventListener(type, (e) => {
        try {
          handle(JSON.parse((e as MessageEvent).data) as T)
        } catch (err) {
          console.warn(`[cloud] ${type} event failed:`, (err as Error).message)
        }
      })
    on("ready", () => {
      if (opened) void this.reconcile().catch((err) => this.fail(err))
      opened = true
    })
    on<ProfileRecord>("profile", (p) => this.applyRemoteProfile(p))
    on<{ prompts: PromptRecord[] }>("prompts", ({ prompts }) => {
      if (prompts.length > 0) this.applyRemotePrompts(prompts)
    })
    on<MeetingRecord>("meeting", (m) => this.importMeeting(m))
    on<{ localId: string }>("meeting-delete", ({ localId }) => {
      this.remoteUpdated.delete(localId)
      this.deps.meetings.delete(localId)
    })
    on("unlinked", () => this.signedOut(t("This device was disconnected from the account in the web dashboard.")))
    es.onerror = (e) => {
      // 401: the token was revoked; anything else that closes the stream: reconnect from scratch.
      if ((e as { code?: number }).code === 401) return this.signedOut(t("Signed out on the server. Connect the account again."))
      if (es.readyState === es.CLOSED && this.events === es) this.fail(new Error(t("Lost the connection to the account.")))
    }
    this.events = es
  }

  // --------------------------------------------------------------- syncing

  /** Full two-way pass: profile, prompts, meetings. Safe to run repeatedly. */
  private async reconcile(): Promise<void> {
    if (!this.deps.settings.get().cloud) return

    // Profile: the server copy wins when it exists, otherwise seed it from this device.
    const { profile } = await this.api<{ profile: ProfileRecord | null }>("GET", "/api/app/profile")
    if (profile) this.applyRemoteProfile(profile)
    else await this.pushProfile(true)

    // Prompts: the server copy wins when it has any, otherwise upload ours.
    const { prompts } = await this.api<{ prompts: PromptRecord[] }>("GET", "/api/app/prompts")
    if (prompts.length > 0) this.applyRemotePrompts(prompts)
    else await this.pushPrompts(true)

    // Meetings: upload what changed here, then take what changed elsewhere.
    const page = await this.api<MeetingsPage>("GET", `/api/app/meetings${this.meetingsSince ? `?since=${encodeURIComponent(this.meetingsSince)}` : ""}`)
    const known = new Set(page.index.map((r) => r.id))
    this.remoteUpdated = new Map(page.index.map((r) => [r.localId, Date.parse(r.updated)]))
    for (const m of this.deps.meetings.list()) {
      // Deleted elsewhere (the dashboard or another device): drop the local copy too.
      if (m.remoteId && !known.has(m.remoteId)) this.deps.meetings.delete(m.id)
    }
    await this.pushMeetings()
    for (const r of page.items) this.importMeeting(r)
    this.meetingsSince = page.syncedAt

    this.lastSync = Date.now()
    this.emitState()
  }

  private localCloudSettings(): CloudSettings {
    const s = this.deps.settings.get()
    const out: Record<string, unknown> = {}
    for (const k of CLOUD_SETTING_KEYS) out[k] = s[k]
    return out as CloudSettings
  }

  private applyRemoteProfile(profile: ProfileRecord): void {
    const remote = profile.settings ?? {}
    this.serverSettingsJson = JSON.stringify(remote)
    const local = this.localCloudSettings()
    const patch: Partial<Settings> = {}
    for (const k of CLOUD_SETTING_KEYS) {
      if (k in remote && JSON.stringify(remote[k]) !== JSON.stringify(local[k])) (patch as Record<string, unknown>)[k] = remote[k]
    }
    if (Object.keys(patch).length === 0) return
    this.applyingRemote = true
    try {
      this.deps.settings.update(patch, "cloud")
    } finally {
      this.applyingRemote = false
    }
  }

  private applyRemotePrompts(remote: PromptRecord[]): void {
    const prompts: Prompt[] = remote.map((r) => ({ id: r.id, title: r.title, content: r.content, notes: r.notes || "" }))
    const active = remote.find((r) => r.active) ?? remote[0]
    const json = JSON.stringify({ prompts, active: active?.id })
    if (json === this.lastPromptsJson) return
    this.lastPromptsJson = json
    this.deps.settings.update({ prompts, activePromptId: active?.id ?? null }, "cloud")
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push().catch((err) => this.fail(err)), PUSH_DEBOUNCE_MS)
  }

  private async push(): Promise<void> {
    if (!this.online || this.applyingRemote) return
    await this.pushProfile(false)
    await this.pushPrompts(false)
    await this.pushMeetings()
    this.lastSync = Date.now()
    this.emitState()
  }

  private async pushProfile(initial: boolean): Promise<void> {
    const local = this.localCloudSettings()
    if (!initial && JSON.stringify(local) === this.serverSettingsJson) return
    const { profile } = await this.api<{ profile: ProfileRecord }>("PUT", "/api/app/profile", { settings: local })
    this.serverSettingsJson = JSON.stringify(profile.settings ?? {})
  }

  /** Mirrors the local prompts to the account; new prompts take the ids the server gives them. */
  private async pushPrompts(initial: boolean): Promise<void> {
    const s = this.deps.settings.get()
    const json = JSON.stringify({ prompts: s.prompts, active: s.activePromptId })
    if (!initial && json === this.lastPromptsJson) return
    const { prompts: stored } = await this.api<{ prompts: PromptRecord[] }>("PUT", "/api/app/prompts", {
      prompts: s.prompts.map((p) => ({ id: p.id, title: p.title, content: p.content, notes: p.notes ?? "", active: p.id === s.activePromptId }))
    })
    // The reply is in the same order as sent.
    const nextPrompts: Prompt[] = s.prompts.map((p, i) => ({ ...p, id: stored[i]?.id ?? p.id }))
    const activeIndex = s.prompts.findIndex((p) => p.id === s.activePromptId)
    const nextActive = activeIndex >= 0 ? nextPrompts[activeIndex].id : s.activePromptId
    this.lastPromptsJson = JSON.stringify({ prompts: nextPrompts, active: nextActive })
    if (nextPrompts.some((p, i) => p.id !== s.prompts[i]?.id)) this.deps.settings.update({ prompts: nextPrompts, activePromptId: nextActive }, "cloud")
  }

  /** Uploads meetings the account doesn't have yet, and ones changed here after the account's copy. */
  private async pushMeetings(): Promise<void> {
    for (const m of this.deps.meetings.list()) {
      if (m.status === "processing" && m.remoteId) continue // wait for the report
      const remote = this.remoteUpdated.get(m.id)
      if (m.remoteId && (remote === undefined || m.updatedAt <= remote + 1000)) continue
      try {
        const saved = await this.api<{ id: string; updated: string }>("PUT", `/api/app/meetings/${encodeURIComponent(m.id)}`, {
          deviceId: this.deps.settings.deviceId(),
          title: m.title,
          startTime: m.startTime,
          endTime: m.endTime,
          duration: m.duration,
          language: m.language,
          status: m.status,
          transcript: m.transcript,
          fullTranscriptText: m.fullTranscriptText,
          summary: m.summary ?? null
        })
        const updated = Date.parse(saved.updated)
        this.remoteUpdated.set(m.id, updated)
        this.deps.meetings.save({ ...m, remoteId: saved.id, updatedAt: updated }, true)
      } catch (err) {
        console.warn("[cloud] meeting push failed:", m.id, (err as Error).message)
      }
    }
  }

  /** A meeting from another device or the dashboard, unless the local copy is newer. */
  private importMeeting(r: MeetingRecord): void {
    const updated = Date.parse(r.updated)
    this.remoteUpdated.set(r.localId, updated)
    const existing = this.deps.meetings.get(r.localId)
    if (existing && existing.updatedAt > updated + 1000) return // changed here since; the next push sends it
    const meeting: Meeting = {
      id: r.localId,
      remoteId: r.id,
      title: r.title,
      startTime: r.startTime,
      endTime: r.endTime,
      duration: r.duration,
      transcript: r.transcript ?? [],
      fullTranscriptText: r.fullTranscriptText ?? "",
      language: (r.language as Meeting["language"]) || "en",
      status: r.status ?? "completed",
      summary: r.summary ?? undefined,
      createdAt: existing?.createdAt ?? Date.parse(r.created),
      updatedAt: updated
    }
    if (
      existing &&
      existing.remoteId === r.id &&
      existing.status === meeting.status &&
      existing.title === meeting.title &&
      JSON.stringify(existing.summary ?? null) === JSON.stringify(meeting.summary ?? null)
    ) {
      return
    }
    this.deps.meetings.save(meeting, true)
  }

  // ------------------------------------------------------------------ state

  /** Offline: say so and try again later, with growing pauses. */
  private fail(err: unknown): void {
    this.error = (err as Error).message
    console.warn("[cloud]", this.error)
    this.disconnect()
    this.setStatus("offline")
    const account = this.deps.settings.get().cloud
    if (!account) return
    const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]
    this.retryTimer = setTimeout(() => {
      const current = this.deps.settings.get().cloud
      if (current) void this.connect(current)
    }, delay)
  }

  private setStatus(status: CloudState["status"]): void {
    this.status = status
    this.emitState()
  }

  private emitState(): void {
    this.emit("state", this.state())
  }
}
