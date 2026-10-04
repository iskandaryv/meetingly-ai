import { app, BrowserWindow, desktopCapturer, session as electronSession, shell } from "electron"
import path from "node:path"
import { registerIpc } from "./ipc"
import { Logger, type LogLevel } from "./services/logger"
import { captureScreen } from "./services/capture"
import { ChatService } from "./services/chat"
import { CloudSync } from "./services/cloud"
import { Llm } from "./services/llm"
import { MeetingStore } from "./services/meetings"
import { ReportGenerator } from "./services/reports"
import { RecordingSession } from "./services/session"
import { AsrModel } from "./services/asrModel"
import { SettingsStore } from "./services/settings"
import { setLocale } from "../shared/i18n"
import { SuggestionService } from "./services/suggestions"
import { PlanService } from "./services/plan"
import { ShortcutManager } from "./shortcuts"
import { createTray } from "./tray"
import { WindowManager } from "./windows/WindowManager"
import { runSmokeTest } from "./smoke"
import { startAutoUpdates } from "./updater"

// Smoke runs use their own profile so they neither collide with a running install
// (single-instance lock) nor touch its settings and meetings.
if (process.env.IGPT_SMOKE) app.setPath("userData", path.join(app.getPath("temp"), "igpt-smoke"))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  app.commandLine.appendSwitch("disable-background-timer-throttling")
  process.on("uncaughtException", (err) => console.error("[main] uncaught:", err))
  process.on("unhandledRejection", (reason) => console.error("[main] unhandled rejection:", reason))


  const userData = app.getPath("userData")
  const logger = new Logger(path.join(userData, "logs", "meetingly.log"), (process.env.IGPT_LOG_LEVEL as LogLevel) || "info")
  captureConsole(logger)
  logger.info("app", "starting", { version: app.getVersion(), platform: process.platform, electron: process.versions.electron, packaged: app.isPackaged })

  const settings = new SettingsStore(path.join(userData, "settings.json"), {
    version: app.getVersion(),
    platform: process.platform,
    locale: app.getLocale()
  })
  setLocale(settings.uiLocale())
  const llm = new Llm(settings)
  const meetings = new MeetingStore(path.join(userData, "meetings.json"))
  const reports = new ReportGenerator({ llm, meetings, settings })
  const asrModel = new AsrModel(process.env.MEETINGLY_MODEL_DIR || path.join(userData, "models"))
  const session = new RecordingSession({ settings, meetings, reports, asrModel })
  const windows = new WindowManager(path.join(__dirname, "preload.js"))
  const chat = new ChatService({
    settings,
    llm,
    session,
    capture: captureScreen,
    hideForCapture: () => windows.hideForCapture()
  })
  const suggestions = new SuggestionService({ settings, llm, session, chat })

  const cloud = new CloudSync({
    settings,
    meetings,
    appVersion: app.getVersion(),
    // Smoke runs must never pop a browser on the desktop.
    openExternal: process.env.IGPT_SMOKE ? async () => {} : (url) => shell.openExternal(url),
    cloudUrl: process.env.IGPT_CLOUD_URL || undefined
  })
  const shortcuts = new ShortcutManager({ settings, windows, session, chat, openWeb: () => void cloud.openWeb() })
  cloud.on("state", (s) => logger.info("cloud", `status ${s.status}`, { email: s.email, error: s.error }))
  const plan = new PlanService({ settings })
  plan.on("state", (s) => logger.info("plan", `${s.status} ${s.plan ?? ""}`, { answers: s.used?.answers, limit: s.limits?.answers }))

  let lastShortcuts = JSON.stringify(settings.get().shortcuts)
  const applySettings = () => {
    const s = settings.get()
    setLocale(settings.uiLocale())
    windows.setStealth(s.stealth)
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.autoLaunch })
    const serialized = JSON.stringify(s.shortcuts)
    if (serialized !== lastShortcuts) {
      lastShortcuts = serialized
      shortcuts.register()
    }
  }

  app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.hide()
    installSystemAudioHandler()
    registerIpc({ settings, windows, session, chat, suggestions, meetings, reports, logger, cloud, plan })
    instrument({ logger, settings, session, chat, windows })
    applySettings()
    settings.onChange(applySettings)
    // A meeting left mid-report by a crash or a quit would sit on "processing" forever.
    void reports.resumeUnfinished()
    // Reconnect to the linked account, if any. Never blocks startup.
    void cloud.start().catch((err) => logger.warn("cloud", "start failed", err))
    if (!process.env.IGPT_SMOKE) plan.start()
    windows.createMain()
    createTray(windows, settings, { openWeb: (page) => void cloud.openWeb(page), openLogs: () => shell.showItemInFolder(logger.file) })
    shortcuts.register()
    if (!process.env.IGPT_SMOKE) startAutoUpdates(logger)
    // Fetch the on-device speech model in the background so the first Listen does not wait for it.
    if (settings.get().transcriptionEngine === "local" && !asrModel.isReady() && !process.env.IGPT_SMOKE) {
      let last = -10
      asrModel.on("progress", (p: number) => {
        if (p >= last + 10) {
          last = p
          logger.info("asr", `model download ${p}%`)
        }
      })
      void asrModel.ensure().then(
        () => logger.info("asr", "model ready"),
        (err) => logger.warn("asr", "model download failed", err)
      )
    }

    // MEETINGLY_AUTOSTART=listen opens the live transcript and starts recording once the windows are up
    // (manual testing; the user stops it from the toolbar).
    if (process.env.MEETINGLY_AUTOSTART === "listen" && !process.env.IGPT_SMOKE) {
      setTimeout(() => {
        windows.showPanel("transcript")
        session.start().then(
          () => logger.info("app", "autostart: recording"),
          (err) => logger.warn("app", "autostart failed", err)
        )
      }, 2500)
    }
    if (process.env.IGPT_SMOKE) void runSmokeTest(process.env.IGPT_SMOKE, { windows, chat, session, settings, cloud, meetings, asrModel })
  })

  app.on("second-instance", () => windows.centerMain())
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createMain()
    else windows.centerMain()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
  app.on("will-quit", () => {
    logger.info("app", "quitting")
    shortcuts.unregister()
    session.cancel()
  })
}

/** Everything already written with console.* lands in the log file too. */
function captureConsole(logger: Logger): void {
  const scopeOf = (args: unknown[]): { scope: string; message: string } => {
    const first = typeof args[0] === "string" ? args[0] : ""
    const match = first.match(/^\[([a-z-]+)\]\s*(.*)$/i)
    const rest = args.slice(1).map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : safeJson(a)))
    if (match) return { scope: match[1], message: [match[2], ...rest].filter(Boolean).join(" ") }
    return { scope: "main", message: [first || safeJson(args[0]), ...rest].filter(Boolean).join(" ") }
  }
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      const { scope, message } = scopeOf(args)
      logger[level === "log" ? "info" : level](scope, message)
      original(...args)
    }
  }
}

interface InstrumentDeps {
  logger: Logger
  settings: SettingsStore
  session: RecordingSession
  chat: ChatService
  windows: WindowManager
}

/** Log the lifecycle events that matter when diagnosing a session afterwards. */
function instrument({ logger, settings, session, chat, windows }: InstrumentDeps): void {
  let lastStatus = ""
  session.on("state", (state) => {
    if (state.status === lastStatus) return
    lastStatus = state.status
    logger.info("session", `status ${state.status}`, {
      connected: state.connected,
      source: state.audioSource,
      device: state.audioDeviceId || "default",
      notice: state.notice
    })
  })
  session.on("utterance", (u) => logger.info("session", "utterance", { speaker: u.speaker, chars: u.text.length }))
  chat.on("message", (m) => logger.info("chat", `${m.role}/${m.kind}`, { chars: m.text.length }))
  chat.on("busy", (busy) => logger.debug("chat", `busy ${busy}`))
  settings.onChange((s) =>
    logger.info("settings", "changed", {
      source: s.audioSource,
      device: s.audioDeviceId || "default",
      autoAnswer: s.autoAnswer,
      answerLength: s.answerLength,
      audioLanguage: s.audioLanguage,
      outputLanguage: s.outputLanguage,
      stealth: s.stealth
    })
  )

  // Renderer console output (audio capture warnings live there) goes to the same file.
  const attach = (kind: string, contents: Electron.WebContents) => {
    contents.on("console-message", (event) => {
      const line = `${event.message} (${path.basename(event.sourceId)}:${event.lineNumber})`
      if (event.level === "error") logger.error(`renderer:${kind}`, line)
      else if (event.level === "warning") logger.warn(`renderer:${kind}`, line)
      else if (/\[(audio|session|chat)\]/.test(event.message)) logger.info(`renderer:${kind}`, event.message)
    })
    contents.on("render-process-gone", (_e, details) => logger.error(`renderer:${kind}`, "process gone", details))
  }
  windows.on("created", (kind: string, contents: Electron.WebContents) => attach(kind, contents))
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Answers the renderer's getDisplayMedia({audio: true}) with system audio, without
 * showing a picker. The "video" half is the requesting window's own frame: we never
 * use the video, and a screen source would go through Windows Graphics Capture,
 * which refuses elevated processes and exclusive-fullscreen sessions (E_ACCESSDENIED).
 * Windows: Chromium loopback. macOS 13+: CoreAudio tap (needs the
 * NSAudioCaptureUsageDescription plist key, set in package.json build.mac.extendInfo).
 * Linux: no loopback here; the renderer uses PulseAudio monitor devices instead.
 */
function installSystemAudioHandler(): void {
  electronSession.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frame = request.frame && !request.frame.isDestroyed?.() ? request.frame : null
      if (frame) {
        callback({ video: frame, audio: "loopback" })
        return
      }
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
        .then((sources) => callback(sources.length ? { video: sources[0], audio: "loopback" } : {}))
        .catch((err) => {
          console.warn("[audio] display media request failed:", err)
          callback({})
        })
    },
    { useSystemPicker: false }
  )
}
