import { useState } from "react"
import { Camera, Captions, Check, EyeOff, LayoutDashboard, MessageSquare, Mic, Pause, Play, Power, UserRound, X } from "lucide-react"
import { DEFAULT_SHORTCUTS } from "@shared/types"
import { t } from "@shared/i18n"
import { api, shortcutLabel } from "@/lib/api"
import { useCloudState, useElapsed, useEvent, useFitWindow, useSessionState, useSettings, useWindowsState } from "@/lib/hooks"
import type { UpdateState } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Dot } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** The always-on-top toolbar. Everything else hangs off it. */
export function MainWindow() {
  const ref = useFitWindow<HTMLDivElement>()
  const session = useSessionState()
  const windows = useWindowsState()
  const [settings] = useSettings()
  const cloud = useCloudState()
  const KEYS = settings?.shortcuts ?? DEFAULT_SHORTCUTS
  // Not linked to an account (and not on an own API key): a quiet way in, next to the other buttons.
  const signedOut = settings !== null && !settings.ownKey && (cloud.status === "off" || cloud.status === "linking" || cloud.status === "error")
  const elapsed = useElapsed(session.startedAt)
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  useEvent("update:state", setUpdate)
  const updateNotice =
    update?.status === "installing"
      ? t("Updating Meetingly to {version}…", { version: update.version ?? "" })
      : update?.status === "needs-move"
        ? t("Move Meetingly to the Applications folder to get updates.")
        : null

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
      // Every finished session becomes a meeting: its report shows on the web dashboard's Meetings page.
      const meeting = await api.invoke("session:finish")
      if (meeting) await api.invoke("cloud:open-web", "meetings")
    })
  const screenshot = () =>
    run(async () => {
      await api.invoke("panel:show", "answers")
      await api.invoke("chat:screenshot")
    })
  const showing = (tab: "answers" | "transcript") => windows.chat && windows.panelTab === tab
  // The panel shows the code to confirm in the browser, so it opens first.
  const signIn = () =>
    run(async () => {
      await api.invoke("panel:show", "answers")
      await api.invoke("cloud:link-start")
    })

  const live = session.status === "recording"
  const paused = session.status === "paused"
  const connecting = session.status === "connecting"

  return (
    <div ref={ref} className="inline-block p-1">
      <div className="glass drag flex h-10 items-center gap-0.5 px-1">
        <Grip />
        <Button variant="ghost" size="icon" onClick={() => api.invoke("windows:toggle-all")} title={t("Hide all windows ({shortcut})", { shortcut: shortcutLabel(KEYS.toggleAll) })}>
          <EyeOff className="h-4 w-4" />
        </Button>

        <Divider />

        {session.status === "idle" ? (
          <Button variant="ghost" size="md" onClick={listen} title={t("Start listening ({shortcut})", { shortcut: shortcutLabel(KEYS.listen) })}>
            <Mic className="h-4 w-4" />
            {t("Listen")}
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            {/* The timer doubles as the live-transcript toggle: closing that window must not strand the session. */}
            <Button
              variant={showing("transcript") ? "secondary" : "ghost"}
              size="md"
              className={cn("gap-1.5 text-xs tabular-nums", live ? "text-rose-300" : "text-white/70")}
              onClick={() => api.invoke("panel:toggle", "transcript")}
              title={showing("transcript") ? t("Hide the live transcript") : t("Show the live transcript")}
            >
              <Dot className={cn(live && "animate-pulse bg-rose-400", paused && "bg-amber-400", connecting && "animate-pulse bg-sky-400")} />
              {elapsed}
              <Captions className="h-4 w-4 opacity-80" />
            </Button>
            {live && (
              <Button variant="ghost" size="icon" onClick={() => run(() => api.invoke("session:pause"))} title={t("Pause")}>
                <Pause className="h-4 w-4" />
              </Button>
            )}
            {paused && (
              <Button variant="ghost" size="icon" onClick={() => run(() => api.invoke("session:resume"))} title={t("Resume")}>
                <Play className="h-4 w-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="text-emerald-300 hover:text-emerald-200" onClick={finish} title={t("Finish and save meeting")}>
              <Check className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="text-white/50" onClick={() => run(() => api.invoke("session:cancel"))} title={t("Discard session")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        <Divider />

        <Button variant={showing("answers") ? "secondary" : "ghost"} size="icon" onClick={() => api.invoke("panel:toggle", "answers")} title={t("Answers and chat ({shortcut})", { shortcut: shortcutLabel(KEYS.chat) })}>
          <MessageSquare className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={screenshot} title={t("Analyze screen ({shortcut})", { shortcut: shortcutLabel(KEYS.screenshot) })}>
          <Camera className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => api.invoke("cloud:open-web")} title={t("Open web dashboard ({shortcut})", { shortcut: shortcutLabel(KEYS.dashboard) })}>
          <LayoutDashboard className="h-4 w-4" />
        </Button>
        {signedOut && (
          <Button variant="ghost" size="icon" className="relative" onClick={signIn} title={t("Sign up free or sign in: 50 AI answers a day")}>
            <UserRound className="h-4 w-4" />
            <span className={cn("absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-sky-400", cloud.status === "linking" && "animate-pulse")} />
          </Button>
        )}

        <Divider />

        <Button variant="ghost" size="icon" className="text-rose-300/80 hover:text-rose-300" onClick={() => api.invoke("app:quit")} title={t("Quit Meetingly")}>
          <Power className="h-4 w-4" />
        </Button>
        <Grip />
      </div>
      {(error || session.notice || updateNotice) && (
        <div className="mt-1 max-w-[520px] truncate rounded-md bg-black/80 px-3 py-1 text-xs text-amber-200">{error ?? session.notice ?? updateNotice}</div>
      )}
    </div>
  )
}

/** A faint handle at each end of the toolbar: a spot to drag it by that is never a button. */
function Grip() {
  return (
    <span aria-hidden className="grid h-6 w-3 shrink-0 grid-cols-2 content-center justify-items-center gap-y-[3px] opacity-25">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} className="block h-[2px] w-[2px] rounded-full bg-white" />
      ))}
    </span>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-white/15" />
}
