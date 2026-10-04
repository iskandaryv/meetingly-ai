import { app, ipcMain, shell, type IpcMainInvokeEvent } from "electron"
import type { InvokeChannel, InvokeMap } from "../../shared/ipc"
import type { ChatService } from "../services/chat"
import type { CloudSync } from "../services/cloud"
import type { PlanService } from "../services/plan"
import type { Logger } from "../services/logger"
import type { MeetingStore } from "../services/meetings"
import type { ReportGenerator } from "../services/reports"
import type { RecordingSession } from "../services/session"
import type { SettingsStore } from "../services/settings"
import type { SuggestionService } from "../services/suggestions"
import { suggestionsVisible } from "../../shared/types"
import { SUGGESTIONS_WIDTH } from "../windows/config"
import type { WindowManager } from "../windows/WindowManager"

export interface IpcDeps {
  settings: SettingsStore
  windows: WindowManager
  session: RecordingSession
  chat: ChatService
  suggestions: SuggestionService
  meetings: MeetingStore
  reports: ReportGenerator
  logger: Logger
  cloud: CloudSync
  plan: PlanService
}

type Handler<K extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<InvokeMap[K]>
) => ReturnType<InvokeMap[K]> | Promise<ReturnType<InvokeMap[K]>>

/** Typed `ipcMain.handle`. Errors are logged once and rejected to the renderer as plain messages. */
function handle<K extends InvokeChannel>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...(args as Parameters<InvokeMap[K]>))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (channel !== "session:audio") console.error(`[ipc] ${channel}: ${message}`)
      throw new Error(message)
    }
  })
}

export function registerIpc(deps: IpcDeps): void {
  const { settings, windows, session, chat, suggestions, meetings, reports, logger, cloud, plan } = deps

  // Settings
  handle("settings:get", () => settings.view())
  handle("settings:update", (_e, patch) => {
    settings.update(patch)
    return settings.view()
  })

  // Windows
  handle("windows:state", () => windows.state())
  handle("windows:show", (_e, kind) => windows.show(kind))
  handle("windows:hide", (_e, kind) => windows.hide(kind))
  handle("windows:toggle", (_e, kind) => windows.toggle(kind))
  handle("windows:toggle-all", () => windows.toggleAll())
  handle("panel:show", (_e, tab) => windows.showPanel(tab))
  handle("panel:toggle", (_e, tab) => windows.togglePanel(tab))
  handle("panel:set-tab", (_e, tab) => windows.setPanelTab(tab))
  handle("windows:fit", (e, size) => {
    const kind = windows.kindOf(e.sender)
    if (kind) windows.fit(kind, size.width, size.height)
  })
  handle("app:quit", () => app.quit())
  handle("app:open-logs", () => {
    shell.showItemInFolder(logger.file)
  })
  handle("app:log", (_e, entry) => {
    // Renderer-side diagnostics land in the same file, in order.
    logger[entry.level]?.(`ui:${entry.scope}`, entry.message, entry.data)
  })

  // Recording session
  handle("session:state", () => session.state())
  handle("session:start", () => session.start())
  handle("session:pause", () => session.pause())
  handle("session:resume", () => session.resume())
  handle("session:finish", () => session.finish())
  handle("session:cancel", () => session.cancel())
  handle("session:audio", (_e, pcm16) => session.sendAudio(pcm16))
  handle("session:transcript", () => session.transcriptText())
  handle("session:last-utterance", () => session.getLastUtterance())

  // Chat
  handle("chat:history", () => chat.getHistory())
  handle("chat:send", (_e, text) => {
    // Fire and forget: the reply streams back through events.
    void chat.send(text)
  })
  handle("chat:answer-last", () => chat.answerLast())
  handle("chat:clear", () => chat.clear())
  handle("chat:screenshot", (_e, prompt) => chat.screenshot(prompt))

  // Suggestions rail
  handle("suggestions:state", () => suggestions.state())
  handle("suggestions:refresh", () => {
    void suggestions.refresh()
  })
  handle("suggestions:use", (_e, id) => {
    // The answer lands in the Answers tab: show it, even when the transcript tab was open.
    if (suggestions.use(id)) windows.showPanel("answers")
  })

  // Account / sync
  handle("cloud:state", () => cloud.state())
  handle("cloud:link-start", () => cloud.linkStart())
  handle("cloud:link-cancel", () => cloud.linkCancel())
  handle("cloud:unlink", () => cloud.unlink())
  handle("cloud:open-web", () => cloud.openWeb())
  handle("cloud:sync-now", () => cloud.syncNow())

  // Plan and usage
  handle("plan:state", () => plan.getState())
  handle("plan:refresh", () => plan.refresh())
  handle("plan:upgrade", () => cloud.openWeb("billing"))

  // Meetings
  handle("meetings:list", () => meetings.list())
  handle("meetings:get", (_e, id) => meetings.get(id))
  handle("meetings:delete", (_e, id) => {
    meetings.delete(id)
  })
  handle("meetings:regenerate", (_e, id) => reports.generate(id))

  /** The panel is wider while the suggestions rail shows (during a session, setting on). */
  const fitPanel = () => windows.setPanelExtra(suggestionsVisible(settings.get(), session.state().status) ? SUGGESTIONS_WIDTH : 0)

  // Push events from services to every window.
  session.on("state", (state) => {
    fitPanel()
    // Audio capture lives in the panel: it must exist (shown or not) whenever a session runs.
    if (state.status !== "idle") windows.ensure("chat")
    else suggestions.reset()
    windows.broadcast("session:state", state)
  })
  session.on("transcript", (event) => windows.broadcast("session:transcript", event))
  session.on("utterance", (utterance) => {
    windows.broadcast("session:utterance", utterance)
    void chat.autoAnswer(utterance)
    suggestions.onUtterance()
  })
  suggestions.on("state", (state) => windows.broadcast("suggestions:state", state))
  chat.on("message", (message) => windows.broadcast("chat:message", message))
  // A hands-free answer is useless if the chat window is hidden.
  // Background: never un-hides the app on its own; the answer waits in chat until the user shows it.
  chat.on("auto-answer", () => windows.showPanel("answers", { background: true }))
  chat.on("chunk", (chunk) => windows.send("chat", "chat:chunk", chunk))
  chat.on("busy", (busy) => windows.broadcast("chat:busy", busy))
  chat.on("cleared", () => windows.broadcast("chat:cleared", undefined))
  meetings.on("changed", () => windows.broadcast("meetings:changed", undefined))
  meetings.on("changed-quiet", () => windows.broadcast("meetings:changed", undefined))
  cloud.on("state", (state) => windows.broadcast("cloud:state", state))
  plan.on("state", (state) => windows.broadcast("plan:state", state))
  // Usage moves with every answer and every limit error; linking or unlinking changes the plan itself.
  chat.on("message", (message) => {
    if (message.role === "assistant") plan.refreshSoon()
  })
  let linkedToken = settings.get().cloud?.token ?? ""
  settings.onChange((s) => {
    const token = s.cloud?.token ?? ""
    if (token !== linkedToken) {
      linkedToken = token
      plan.refreshSoon(500)
    }
  })
  windows.on("state", (state) => windows.broadcast("windows:state", state))
  settings.onChange(() => {
    fitPanel()
    // Turned on mid-session: start from what was said so far.
    if (suggestionsVisible(settings.get(), session.state().status)) suggestions.onUtterance()
    windows.broadcast("settings:changed", settings.view())
    // Session state carries the audio source, so the recording window restarts
    // its capture when the source or device changes mid-session.
    windows.broadcast("session:state", session.state())
  })
  settings.on("conflicts", () => windows.broadcast("settings:changed", settings.view()))
}
