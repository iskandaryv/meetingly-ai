import { EventEmitter } from "node:events"
import os from "node:os"
import PocketBase, { type RecordModel, type RecordSubscription } from "pocketbase"
import { EventSource } from "eventsource"
import { CLOUD_SETTING_KEYS, cloudUrl, type CloudAccount, type CloudState } from "../../shared/cloud"
import type { Meeting, Prompt, Settings } from "../../shared/types"
import type { MeetingStore } from "./meetings"
import type { SettingsStore } from "./settings"

// PocketBase realtime rides on EventSource, which Electron's main process lacks.
if (!(globalThis as { EventSource?: unknown }).EventSource) (globalThis as { EventSource?: unknown }).EventSource = EventSource

interface Deps {
  settings: SettingsStore
  meetings: MeetingStore
  appVersion: string
  openExternal: (url: string) => Promise<void>
  cloudUrl?: string
}

interface ProfileRecord extends RecordModel {
  user: string
  settings: Partial<Pick<Settings, (typeof CLOUD_SETTING_KEYS)[number]>> | null
  version: number
}

interface PromptRecord extends RecordModel {
  user: string
  title: string
  content: string
  notes: string
  active: boolean
  position: number
}

interface MeetingRecord extends RecordModel {
  user: string
  localId: string
  deviceId: string
  title: string
  startTime: number
  endTime: number
  duration: number
  language: string
  status: Meeting["status"]
  transcript: Meeting["transcript"]
  fullTranscriptText: string
  summary: Meeting["summary"] | null
}

const POLL_MS = 2000
const LINK_TIMEOUT_MS = 10 * 60 * 1000
const PUSH_DEBOUNCE_MS = 800
const RECONCILE_MS = 5 * 60 * 1000

/**
 * Keeps this device in step with the user's account: settings and prompts in
 * both directions (realtime), meetings uploaded and deletions mirrored.
 *
 * Events: "state" (CloudState)
 */
export class CloudSync extends EventEmitter {
  private pb: PocketBase | null = null
  private status: CloudState["status"] = "off"
  private error: string | undefined
  private lastSync: number | undefined
  private linking: { code: string; url: string; timer: NodeJS.Timeout; deadline: number } | null = null
  private profile: ProfileRecord | null = null
  private applyingRemote = false
  private pushTimer: NodeJS.Timeout | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private unsubscribers: (() => void)[] = []
  /** Local prompt id -> remote record id (identical once synced). */
  private lastPromptsJson = ""

  constructor(private readonly deps: Deps) {
    super()
    deps.settings.onChange((s, origin) => {
      if (origin === "cloud" || !this.pb || this.status !== "online") return
      this.schedulePush()
    })
    deps.meetings.on("changed", () => {
      if (this.pb && this.status === "online") this.schedulePush()
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
    const deviceId = this.deps.settings.deviceId()
    const res = await fetch(`${base}/api/igpt/link/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, name: os.hostname(), platform: process.platform, appVersion: this.deps.appVersion })
    })
    if (!res.ok) throw new Error(`Account service unavailable (HTTP ${res.status})`)
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
    const account = this.deps.settings.get().cloud
    if (account && this.pb) {
      // Best effort: remove this device from the account's device list.
      try {
        const device = await this.pb.collection("devices").getFirstListItem(`deviceId = "${this.deps.settings.deviceId()}"`)
        await this.pb.collection("devices").delete(device.id)
      } catch {
        /* already gone or offline */
      }
    }
    this.pb = null
    this.deps.settings.update({ cloud: null }, "cloud")
    this.setStatus("off")
    return this.state()
  }

  async openWeb(): Promise<void> {
    const account = this.deps.settings.get().cloud
    const base = cloudUrl(this.deps.cloudUrl)
    if (!account || !this.pb?.authStore.token) return this.deps.openExternal(`${base}/#/`)
    await this.deps.openExternal(`${base}/#/auth?token=${encodeURIComponent(this.pb.authStore.token)}`)
  }

  async syncNow(): Promise<CloudState> {
    if (this.pb && this.status !== "off") await this.reconcile().catch((err) => this.fail(err))
    return this.state()
  }

  // ---------------------------------------------------------------- linking

  private async pollLink(): Promise<void> {
    const link = this.linking
    if (!link) return
    if (Date.now() > link.deadline) {
      this.stopLinking()
      this.error = "The code expired before the browser confirmed it."
      this.setStatus(this.deps.settings.get().cloud ? "offline" : "off")
      return
    }
    try {
      const base = cloudUrl(this.deps.cloudUrl)
      const res = await fetch(`${base}/api/igpt/link/poll?code=${link.code}&deviceId=${this.deps.settings.deviceId()}`)
      if (!res.ok) return
      const body = (await res.json()) as { pending: boolean; expired?: boolean; token?: string; user?: { id: string; email: string; name?: string } }
      if (body.pending) return
      this.stopLinking()
      if (body.expired || !body.token || !body.user) {
        this.error = "The code expired. Start again."
        this.setStatus(this.deps.settings.get().cloud ? "offline" : "off")
        return
      }
      const account: CloudAccount = { url: base, token: body.token, userId: body.user.id, email: body.user.email, name: body.user.name, linkedAt: Date.now() }
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

  private async connect(account: CloudAccount): Promise<void> {
    this.disconnect()
    const pb = new PocketBase(cloudUrl(this.deps.cloudUrl || account.url))
    pb.autoCancellation(false)
    pb.authStore.save(account.token)
    this.pb = pb
    try {
      const auth = await pb.collection("users").authRefresh()
      // Persist the renewed token so the device never expires while in use.
      this.deps.settings.update({ cloud: { ...account, token: auth.token, email: String(auth.record.email ?? account.email) } }, "cloud")
      const me = await pb.send<{ linked: boolean }>(`/api/igpt/me?deviceId=${this.deps.settings.deviceId()}`, { method: "GET" })
      if (!me.linked) {
        this.error = "This device was disconnected from the account in the web dashboard."
        this.pb = null
        this.deps.settings.update({ cloud: null }, "cloud")
        this.setStatus("off")
        return
      }
      await this.reconcile()
      await this.subscribe()
      this.reconcileTimer = setInterval(() => void this.reconcile().catch((err) => this.fail(err)), RECONCILE_MS)
      this.error = undefined
      this.setStatus("online")
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 401 || status === 403 || status === 404) {
        this.error = "Signed out on the server. Connect the account again."
        this.pb = null
        this.deps.settings.update({ cloud: null }, "cloud")
        this.setStatus("off")
        return
      }
      this.fail(err)
    }
  }

  private disconnect(): void {
    for (const off of this.unsubscribers.splice(0)) off()
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.profile = null
  }

  private async subscribe(): Promise<void> {
    const pb = this.pb!
    const onProfile = (e: RecordSubscription<ProfileRecord>) => {
      if (e.action === "delete") return
      this.applyRemoteProfile(e.record)
    }
    const onPrompt = () => void this.pullPrompts().catch((err) => console.warn("[cloud] prompts pull failed:", (err as Error).message))
    const onMeeting = (e: RecordSubscription<MeetingRecord>) => {
      if (e.action === "delete") this.deps.meetings.delete(e.record.localId)
      else this.importMeeting(e.record)
    }
    this.unsubscribers.push(
      await pb.collection("profiles").subscribe<ProfileRecord>("*", onProfile),
      await pb.collection("prompts").subscribe<PromptRecord>("*", onPrompt),
      await pb.collection("meetings").subscribe<MeetingRecord>("*", onMeeting)
    )
  }

  // --------------------------------------------------------------- syncing

  /** Full two-way pass: profile, prompts, meetings. Safe to run repeatedly. */
  private async reconcile(): Promise<void> {
    const pb = this.pb
    if (!pb) return
    const userId = this.deps.settings.get().cloud?.userId
    if (!userId) return

    // Profile: server copy wins when it exists, otherwise seed it from this device.
    let profile: ProfileRecord
    try {
      profile = await pb.collection("profiles").getFirstListItem<ProfileRecord>(`user = "${userId}"`)
      this.applyRemoteProfile(profile)
    } catch {
      profile = await pb.collection("profiles").create<ProfileRecord>({ user: userId, settings: this.localCloudSettings(), version: 1 })
    }
    this.profile = profile

    // Prompts: server copy wins when it has any, otherwise upload ours.
    const remote = await pb.collection("prompts").getFullList<PromptRecord>({ sort: "position,created" })
    if (remote.length > 0) this.applyRemotePrompts(remote)
    else await this.pushPrompts(true)

    await this.pushMeetings()
    await this.pullMeetings()

    this.lastSync = Date.now()
    this.emitState()
  }

  private localCloudSettings(): ProfileRecord["settings"] {
    const s = this.deps.settings.get()
    const out: Record<string, unknown> = {}
    for (const k of CLOUD_SETTING_KEYS) out[k] = s[k]
    return out as ProfileRecord["settings"]
  }

  private applyRemoteProfile(profile: ProfileRecord): void {
    this.profile = profile
    const remote = profile.settings ?? {}
    const local = this.localCloudSettings() ?? {}
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

  private async pullPrompts(): Promise<void> {
    if (!this.pb) return
    const remote = await this.pb.collection("prompts").getFullList<PromptRecord>({ sort: "position,created" })
    if (remote.length > 0) this.applyRemotePrompts(remote)
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push().catch((err) => this.fail(err)), PUSH_DEBOUNCE_MS)
  }

  private async push(): Promise<void> {
    if (!this.pb || this.applyingRemote) return
    await this.pushProfile()
    await this.pushPrompts(false)
    await this.pushMeetings()
    this.lastSync = Date.now()
    this.emitState()
  }

  private async pushProfile(): Promise<void> {
    const pb = this.pb!
    if (!this.profile) return
    const local = this.localCloudSettings()
    if (JSON.stringify(local) === JSON.stringify(this.profile.settings)) return
    this.profile = await pb.collection("profiles").update<ProfileRecord>(this.profile.id, { settings: local, version: (this.profile.version ?? 0) + 1 })
  }

  /** Mirror local prompts to the server. Local ids become the server ids on first upload. */
  private async pushPrompts(initial: boolean): Promise<void> {
    const pb = this.pb!
    const s = this.deps.settings.get()
    const json = JSON.stringify({ prompts: s.prompts, active: s.activePromptId })
    if (!initial && json === this.lastPromptsJson) return

    const userId = s.cloud?.userId
    if (!userId) return
    const remote = await pb.collection("prompts").getFullList<PromptRecord>()
    const remoteById = new Map(remote.map((r) => [r.id, r]))
    const nextPrompts: Prompt[] = []
    let nextActive = s.activePromptId

    for (const [index, p] of s.prompts.entries()) {
      const data = { user: userId, title: p.title, content: p.content, notes: p.notes ?? "", active: p.id === s.activePromptId, position: index }
      const existing = remoteById.get(p.id)
      if (existing) {
        remoteById.delete(p.id)
        if (existing.title !== data.title || existing.content !== data.content || (existing.notes || "") !== data.notes || existing.active !== data.active || existing.position !== index) {
          await pb.collection("prompts").update(existing.id, data)
        }
        nextPrompts.push(p)
      } else {
        const created = await pb.collection("prompts").create<PromptRecord>(data)
        nextPrompts.push({ ...p, id: created.id })
        if (s.activePromptId === p.id) nextActive = created.id
      }
    }
    for (const orphan of remoteById.values()) await pb.collection("prompts").delete(orphan.id)

    const changedIds = nextPrompts.some((p, i) => p.id !== s.prompts[i]?.id)
    this.lastPromptsJson = JSON.stringify({ prompts: nextPrompts, active: nextActive })
    if (changedIds) this.deps.settings.update({ prompts: nextPrompts, activePromptId: nextActive }, "cloud")
  }

  private async pushMeetings(): Promise<void> {
    const pb = this.pb!
    const userId = this.deps.settings.get().cloud?.userId
    if (!userId) return
    for (const m of this.deps.meetings.list()) {
      if (m.status === "processing" && m.remoteId) continue // wait for the report
      const data = {
        user: userId,
        localId: m.id,
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
      }
      try {
        if (m.remoteId) {
          const remote = await pb.collection("meetings").getOne<MeetingRecord>(m.remoteId).catch(() => null)
          if (!remote) continue // deleted on the server: leave the local copy alone
          if (remote.status !== m.status || remote.title !== m.title || JSON.stringify(remote.summary ?? null) !== JSON.stringify(m.summary ?? null)) {
            await pb.collection("meetings").update(m.remoteId, data)
          }
        } else {
          let record: MeetingRecord
          try {
            record = await pb.collection("meetings").getFirstListItem<MeetingRecord>(`localId = "${m.id}"`)
            await pb.collection("meetings").update(record.id, data)
          } catch {
            record = await pb.collection("meetings").create<MeetingRecord>(data)
          }
          this.deps.meetings.save({ ...m, remoteId: record.id }, true)
        }
      } catch (err) {
        console.warn("[cloud] meeting push failed:", m.id, (err as Error).message)
      }
    }
  }

  /** Meetings from other devices, or ones deleted in the browser. */
  private async pullMeetings(): Promise<void> {
    const pb = this.pb!
    const remote = await pb.collection("meetings").getFullList<MeetingRecord>({ sort: "-startTime" })
    const remoteIds = new Set(remote.map((r) => r.id))
    for (const r of remote) this.importMeeting(r)
    for (const m of this.deps.meetings.list()) {
      if (m.remoteId && !remoteIds.has(m.remoteId)) this.deps.meetings.delete(m.id)
    }
  }

  private importMeeting(r: MeetingRecord): void {
    const existing = this.deps.meetings.get(r.localId)
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
      createdAt: existing?.createdAt ?? new Date(r.created).getTime(),
      updatedAt: new Date(r.updated).getTime()
    }
    if (existing && existing.remoteId === r.id && existing.status === meeting.status && JSON.stringify(existing.summary ?? null) === JSON.stringify(meeting.summary ?? null) && existing.title === meeting.title) return
    this.deps.meetings.save(meeting, true)
  }

  // ------------------------------------------------------------------ state

  private fail(err: unknown): void {
    this.error = (err as Error).message
    console.warn("[cloud]", this.error)
    this.setStatus("offline")
  }

  private setStatus(status: CloudState["status"]): void {
    this.status = status
    this.emitState()
  }

  private emitState(): void {
    this.emit("state", this.state())
  }
}
