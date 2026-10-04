import { BrowserWindow, Menu, type WebContents } from "electron"
import { contextMenuTemplate, HAS_SELECTION_JS } from "./copy-menu"

/**
 * Copies the selected text of the focused Meetingly window, if there is any. Ctrl+C is also a global
 * shortcut (Toggle chat by default), which Windows hands to Meetingly before the window sees the key,
 * so the shortcut handler copies here first and only toggles when nothing is selected.
 */
export async function copyFocusedSelection(): Promise<boolean> {
  return copySelection(BrowserWindow.getFocusedWindow())
}

/** Copies the window's selected text; false when nothing is selected. */
export async function copySelection(win: BrowserWindow | null): Promise<boolean> {
  if (!win || win.isDestroyed()) return false
  const selected = await win.webContents.executeJavaScript(HAS_SELECTION_JS, true).catch(() => false)
  if (!selected) return false
  win.webContents.copy()
  return true
}

/** Right-click: Copy on selected text; Cut, Copy, Paste and Select all in text boxes. */
export function attachContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_e, params) => {
    const template = contextMenuTemplate(params)
    if (template.length) Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
  })
}
