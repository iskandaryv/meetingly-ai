import { useState } from "react"
import { Camera, Captions, Check, EyeOff, LayoutDashboard, MessageSquare, Mic, Pause, Play, Power, X } from "lucide-react"
import { DEFAULT_SHORTCUTS } from "@shared/types"
import { api, shortcutLabel } from "@/lib/api"
import { useElapsed, useFitWindow, useSessionState, useSettings, useWindowsState } from "@/lib/hooks"
import { Button } from "@/components/ui/button"
import { Dot } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** The always-on-top toolbar. Everything else hangs off it. */
export function MainWindow() {
  const ref = useFitWindow<HTMLDivElement>()
  const session = useSessionState()
  const windows = useWindowsState()
  const [settings] = useSettings()
  const KEYS = settings?.shortcuts ?? DEFAULT_SHORTCUTS
  const elapsed = useElapsed(session.startedAt)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    try {
      setError(null)
      await action()
    } catch (err) {
      setError((err as Error).message)
      setTimeout(() => setError(null), 6000)
    }
  }

  const listen = () =>
    run(async () => {
      await api.invoke("panel:show", "transcript")
      await api.invoke("session:start")
    })
  const finish = () =>
    run(async () => {
      const meeting = await api.invoke("session:finish")
      if (meeting) await api.invoke("windows:show", "dashboard")
    })
  const screenshot = () =>
    run(async () => {
      await api.invoke("panel:show", "answers")
      await api.invoke("chat:screenshot")
    })
  const showing = (tab: "answers" | "transcript") => windows.chat && windows.panelTab === tab

  const live = session.status === "recording"
  const paused = session.status === "paused"
  const connecting = session.status === "connecting"

  return (
    <div ref={ref} className="inline-block p-1">
      <div className="glass drag flex h-10 items-center gap-0.5 px-1.5">
        <Button variant="ghost" size="icon" onClick={() => api.invoke("windows:toggle-all")} title={`Hide all windows (${shortcutLabel(KEYS.toggleAll)})`}>
          <EyeOff className="h-4 w-4" />
        </Button>

        <Divider />

        {session.status === "idle" ? (
          <Button variant="ghost" size="md" onClick={listen} title={`Start listening (${shortcutLabel(KEYS.listen)})`}>
            <Mic className="h-4 w-4" />
            Listen
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            {/* The timer doubles as the live-transcript toggle: closing that window must not strand the session. */}
            <Button
              variant={showing("transcript") ? "secondary" : "ghost"}
              size="md"
              className={cn("gap-1.5 text-xs tabular-nums", live ? "text-rose-300" : "text-white/70")}
              onClick={() => api.invoke("panel:toggle", "transcript")}
              title={showing("transcript") ? "Hide the live transcript" : "Show the live transcript"}
            >
              <Dot className={cn(live && "animate-pulse bg-rose-400", paused && "bg-amber-400", connecting && "animate-pulse bg-sky-400")} />
              {elapsed}
              <Captions className="h-4 w-4 opacity-80" />
            </Button>
            {live && (
              <Button variant="ghost" size="icon" onClick={() => run(() => api.invoke("session:pause"))} title="Pause">
                <Pause className="h-4 w-4" />
              </Button>
            )}
            {paused && (
              <Button variant="ghost" size="icon" onClick={() => run(() => api.invoke("session:resume"))} title="Resume">
                <Play className="h-4 w-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="text-emerald-300 hover:text-emerald-200" onClick={finish} title="Finish and save meeting">
              <Check className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="text-white/50" onClick={() => run(() => api.invoke("session:cancel"))} title="Discard session">
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        <Divider />

        <Button variant={showing("answers") ? "secondary" : "ghost"} size="icon" onClick={() => api.invoke("panel:toggle", "answers")} title={`Answers and chat (${shortcutLabel(KEYS.chat)})`}>
          <MessageSquare className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={screenshot} title={`Analyze screen (${shortcutLabel(KEYS.screenshot)})`}>
          <Camera className="h-4 w-4" />
        </Button>
        <Button
          variant={windows.dashboard ? "secondary" : "ghost"}
          size="icon"
          onClick={() => api.invoke("windows:toggle", "dashboard")}
          title={`Dashboard (${shortcutLabel(KEYS.dashboard)})`}
        >
          <LayoutDashboard className="h-4 w-4" />
        </Button>

        <Divider />

        <Button variant="ghost" size="icon" className="text-rose-300/80 hover:text-rose-300" onClick={() => api.invoke("app:quit")} title="Quit Meetingly">
          <Power className="h-4 w-4" />
        </Button>
      </div>
      {(error || session.notice) && (
        <div className="mt-1 max-w-[520px] truncate rounded-md bg-black/80 px-3 py-1 text-xs text-amber-200">{error ?? session.notice}</div>
      )}
    </div>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-white/15" />
}
