import { app } from "electron"
import { autoUpdater } from "electron-updater"
import type { UpdateState } from "../shared/types"
import type { Logger } from "./services/logger"
import { MacUpdater, type MacUpdate } from "./mac-updater"

const FEED_URL = "https://meetinglyai.com/download"
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** An update ready this soon after launch installs right away: the app restarts on the new version. */
const LAUNCH_WINDOW_MS = 10 * 60 * 1000
/** Long enough to read "Updating…" on the toolbar. */
const NOTICE_MS = 1500

interface Deps {
  logger: Logger
  /** True while a listening session runs: an update never restarts the app in the middle of a meeting. */
  isBusy: () => boolean
  onState: (state: UpdateState) => void
}

/**
 * Updates install themselves from https://meetinglyai.com/download/, on every platform:
 * - at launch the app checks; an update found (or already downloaded) then installs right away and the
 *   app comes back on the new version within seconds, before a meeting starts;
 * - while running it checks every few hours and downloads in the background; that update installs when
 *   the app quits, or at the next launch.
 * Windows and Linux (AppImage) use electron-updater; the Mac build has its own updater (mac-updater.ts),
 * since Apple's only accepts apps signed with a paid Developer ID.
 * MEETINGLY_UPDATE_URL points the app at another feed (the update test in CI).
 */
export function startAutoUpdates(deps: Deps): void {
  if (!app.isPackaged) return
  const feed = (process.env.MEETINGLY_UPDATE_URL || FEED_URL).replace(/\/+$/, "")
  const launchedAt = Date.now()
  const installNow = () => Date.now() - launchedAt < LAUNCH_WINDOW_MS && !deps.isBusy()
  if (process.platform === "darwin") startMac(deps, feed, installNow)
  else startElectronUpdater(deps, feed, installNow)
}

function startElectronUpdater({ logger, onState }: Deps, feed: string, installNow: () => boolean): void {
  autoUpdater.logger = {
    info: (m: unknown) => logger.info("updater", String(m)),
    warn: (m: unknown) => logger.warn("updater", String(m)),
    error: (m: unknown) => logger.error("updater", String(m)),
    debug: (m: unknown) => logger.debug("updater", String(m))
  }
  if (process.env.MEETINGLY_UPDATE_URL) autoUpdater.setFeedURL({ provider: "generic", url: feed })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // The installer we publish is the full one, never the small web stub.
  autoUpdater.disableWebInstaller = true
  autoUpdater.on("update-available", (info) => logger.info("updater", `update available: ${info.version}`))
  autoUpdater.on("update-downloaded", (info) => {
    if (!installNow()) {
      logger.info("updater", `update downloaded, installs on quit: ${info.version}`)
      return
    }
    logger.info("updater", `installing ${info.version} now`)
    onState({ status: "installing", version: info.version })
    // Silent install, then start the new version.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), NOTICE_MS)
  })
  autoUpdater.on("error", (err) => logger.warn("updater", "check failed", err))

  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 3000)
  setInterval(check, CHECK_INTERVAL_MS).unref()
}

function startMac({ logger, onState }: Deps, feed: string, installNow: () => boolean): void {
  const mac = new MacUpdater(feed)
  if (!mac.bundlePath()) {
    // Run from the disk image or from a translocated copy: there is nothing to replace in place.
    logger.warn("updater", `can't update in place from ${process.execPath}`)
    onState({ status: "needs-move" })
    return
  }
  let downloaded: MacUpdate | null = null
  let installing = false

  const install = (update: MacUpdate) => {
    installing = true
    logger.info("updater", `installing ${update.version} now`)
    onState({ status: "installing", version: update.version })
    if (mac.install(update, true)) setTimeout(() => app.quit(), NOTICE_MS)
  }

  // An update downloaded in an earlier session goes in before anything else.
  const pending = mac.ready()
  if (pending) {
    install(pending)
    return
  }

  const check = async () => {
    if (downloaded || installing) return
    try {
      const update = await mac.fetchUpdate()
      if (!update) return
      downloaded = update
      if (installNow()) install(update)
      else logger.info("updater", `update downloaded, installs on quit: ${update.version}`)
    } catch (err) {
      logger.warn("updater", "check failed", err)
    }
  }
  app.on("before-quit", () => {
    if (downloaded && !installing) {
      installing = true
      mac.install(downloaded, false)
    }
  })
  setTimeout(() => void check(), 3000)
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref()
}
