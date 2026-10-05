import { app, Menu, nativeImage, Tray } from "electron"
import path from "node:path"
import { t } from "../shared/i18n"
import type { SettingsStore } from "./services/settings"
import type { WindowManager } from "./windows/WindowManager"

let tray: Tray | null = null

interface TrayActions {
  /** The web dashboard (signed in): the overview, or a page such as the guide. */
  openWeb: (page?: "guide") => void
  openLogs: () => void
  /** The panel with the "use your own API key" form. */
  ownKey: () => void
}

export function createTray(windows: WindowManager, settings: SettingsStore, actions: TrayActions): Tray {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray.png")
    : path.join(app.getAppPath(), "build", "tray.png")
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  if (process.platform === "darwin") icon = icon.resize({ width: 18, height: 18 })

  tray = new Tray(icon)
  // Tooltip and menu follow the shortcut and the interface language, so rebuild them on settings changes.
  const refresh = () => {
    const key = settings.get().shortcuts.showToolbar.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl")
    tray?.setToolTip(t("Meetingly ({key} shows the toolbar)", { key }))
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: t("Show toolbar"), click: () => windows.centerMain() },
        { label: t("Show / hide all windows"), click: () => windows.toggleAll() },
        { label: t("Live transcript"), click: () => windows.showPanel("transcript") },
        { type: "separator" },
        { label: t("Open web dashboard"), click: () => actions.openWeb() },
        { label: t("Guide"), click: () => actions.openWeb("guide") },
        { label: t("Use your own API key…"), click: () => actions.ownKey() },
        { label: t("Open the log folder"), click: () => actions.openLogs() },
        { type: "separator" },
        { label: t("Quit Meetingly"), click: () => app.quit() }
      ])
    )
  }
  refresh()
  settings.onChange(refresh)
  tray.on("double-click", () => windows.centerMain())
  return tray
}
