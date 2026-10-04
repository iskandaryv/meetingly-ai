import { EventEmitter } from "node:events"
import { APP_TOKEN, relayHttpUrl } from "../../shared/relay"
import type { PlanState } from "../../shared/types"
import { relayIdentity } from "./relayAuth"
import type { SettingsStore } from "./settings"

const REFRESH_MS = 5 * 60_000

interface Deps {
  settings: Pick<SettingsStore, "get" | "deviceId" | "appVersion">
  fetch?: typeof fetch
  relayUrl?: string
}

/**
 * The account's plan and today's usage, as the relay counts it (GET /v1/usage). Refreshed every few
 * minutes and whenever something may have changed it (an answer, a limit error, linking an account).
 *
 * Events: "state" (PlanState)
 */
export class PlanService extends EventEmitter {
  private state: PlanState = { status: "unknown" }
  private timer: NodeJS.Timeout | null = null
  private pending: NodeJS.Timeout | null = null

  constructor(private readonly deps: Deps) {
    super()
  }

  getState(): PlanState {
    return this.state
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.pending) clearTimeout(this.pending)
    this.timer = this.pending = null
  }

  /** Refresh a moment from now; repeated calls within the delay collapse into one request. */
  refreshSoon(delayMs = 2000): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = setTimeout(() => {
      this.pending = null
      void this.refresh()
    }, delayMs)
  }

  async refresh(): Promise<PlanState> {
    const fetchImpl = this.deps.fetch ?? fetch
    try {
      const res = await fetchImpl(`${relayHttpUrl(this.deps.relayUrl ?? process.env.IGPT_RELAY_URL ?? undefined)}/v1/usage`, {
        headers: { Authorization: `Bearer ${APP_TOKEN}`, ...relayIdentity(this.deps.settings) },
        signal: AbortSignal.timeout(15_000)
      })
      if (res.status === 200) {
        const body = (await res.json()) as Omit<PlanState, "status">
        this.set({ status: "ok", plan: body.plan, used: body.used, limits: body.limits, resetAt: body.resetAt })
      } else if (res.status === 401) {
        this.set({ status: "signed-out" })
      } else if (this.state.status === "unknown") {
        this.set({ status: "offline" })
      }
    } catch {
      if (this.state.status === "unknown") this.set({ status: "offline" })
    }
    return this.state
  }

  private set(state: PlanState): void {
    this.state = state
    this.emit("state", state)
  }
}
