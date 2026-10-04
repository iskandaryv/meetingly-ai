import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { EventChannel, EventMap } from "@shared/ipc"
import type { CloudState } from "@shared/cloud"
import type { PlanState, SessionState, SettingsView, SuggestionsState, WindowsState } from "@shared/types"
import { api } from "./api"

/** Subscribe to a main-process event for the lifetime of the component. */
export function useEvent<K extends EventChannel>(channel: K, handler: (payload: EventMap[K]) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => api.on(channel, (payload) => ref.current(payload)), [channel])
}

export function useSettings(): [SettingsView | null, (patch: Partial<SettingsView>) => Promise<void>] {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  useEffect(() => {
    void api.invoke("settings:get").then(setSettings)
  }, [])
  useEvent("settings:changed", setSettings)
  const update = useCallback(async (patch: Partial<SettingsView>) => {
    const { version, platform, shortcutConflicts, cloud, ...rest } = patch
    void version, platform, shortcutConflicts, cloud
    setSettings(await api.invoke("settings:update", rest))
  }, [])
  return [settings, update]
}

const IDLE: SessionState = { status: "idle", startedAt: null, notice: null, connected: false, audioSource: "both", audioDeviceId: "" }

export function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>(IDLE)
  useEffect(() => {
    void api.invoke("session:state").then(setState)
  }, [])
  useEvent("session:state", setState)
  return state
}

export function useWindowsState(): WindowsState {
  const [state, setState] = useState<WindowsState>({ chat: false, dashboard: false, panelTab: "answers" })
  useEffect(() => {
    void api.invoke("windows:state").then(setState)
  }, [])
  useEvent("windows:state", setState)
  return state
}

export function useSuggestions(): SuggestionsState {
  const [state, setState] = useState<SuggestionsState>({ topic: "", items: [], updating: false })
  useEffect(() => {
    void api.invoke("suggestions:state").then(setState)
  }, [])
  useEvent("suggestions:state", setState)
  return state
}

/** Ask the main process to size this window to the measured element. */
export function useFitWindow<T extends HTMLElement>(extra = { width: 0, height: 0 }): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const fit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        void api.invoke("windows:fit", {
          width: Math.ceil(rect.width) + extra.width,
          height: Math.ceil(rect.height) + extra.height
        })
      })
    }
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    fit()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [extra.width, extra.height])
  return ref
}

export function usePlanState(): PlanState {
  const [state, setState] = useState<PlanState>({ status: "unknown" })
  useEffect(() => {
    void api.invoke("plan:state").then(setState)
  }, [])
  useEvent("plan:state", setState)
  return state
}

export function useCloudState(): CloudState {
  const [state, setState] = useState<CloudState>({ status: "off" })
  useEffect(() => {
    void api.invoke("cloud:state").then(setState)
  }, [])
  useEvent("cloud:state", setState)
  return state
}

/** mm:ss elapsed since `since`, ticking once a second. */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!since) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  if (!since) return "00:00"
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}
