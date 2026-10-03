import { app } from "electron"
import { autoUpdater } from "electron-updater"
import type { Logger } from "./services/logger"

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Background updates from https://meetinglyai.com/download/ (publish.url in
 * package.json). Downloads silently; the new version installs on the next
 * quit, so an update never interrupts a live meeting.
 */
export function startAutoUpdates(logger: Logger): void {
  if (!app.isPackaged) return
  autoUpdater.logger = {
    info: (m: unknown) => logger.info("updater", String(m)),
    warn: (m: unknown) => logger.warn("updater", String(m)),
    error: (m: unknown) => logger.error("updater", String(m)),
    debug: (m: unknown) => logger.debug("updater", String(m))
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on("update-available", (info) => logger.info("updater", `update available: ${info.version}`))
  autoUpdater.on("update-downloaded", (info) => logger.info("updater", `update downloaded, installs on quit: ${info.version}`))
  autoUpdater.on("error", (err) => logger.warn("updater", "check failed", err))

  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 30_000)
  setInterval(check, CHECK_INTERVAL_MS).unref()
}
