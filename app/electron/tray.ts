import { app, Menu, nativeImage, Tray } from "electron"
import path from "node:path"
import type { SettingsStore } from "./services/settings"
import type { WindowManager } from "./windows/WindowManager"

let tray: Tray | null = null

export function createTray(windows: WindowManager, settings: SettingsStore): Tray {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray.png")
    : path.join(app.getAppPath(), "build", "tray.png")
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  if (process.platform === "darwin") icon = icon.resize({ width: 18, height: 18 })

  tray = new Tray(icon)
  const refreshTooltip = () => {
    const key = settings.get().shortcuts.showToolbar.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl")
    tray?.setToolTip(`Meetingly (${key} shows the toolbar)`)
  }
  refreshTooltip()
  settings.onChange(refreshTooltip)

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show toolbar", click: () => windows.centerMain() },
      { label: "Show / hide all windows", click: () => windows.toggleAll() },
      { label: "Live transcript", click: () => windows.showPanel("transcript") },
      { label: "Dashboard", click: () => windows.show("dashboard") },
      { type: "separator" },
      { label: "Quit Meetingly", click: () => app.quit() }
    ])
  )
  tray.on("double-click", () => windows.centerMain())
  return tray
}
