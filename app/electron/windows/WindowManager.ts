import { app, BrowserWindow, screen, type Rectangle, type WebContents } from "electron"
import path from "node:path"
import { EventEmitter } from "node:events"
import type { EventChannel, EventMap } from "../../shared/ipc"
import type { PanelTab, WindowKind, WindowsState } from "../../shared/types"
import { MAIN_TOP_MARGIN, MOVE_STEP, PANEL_OVERLAP, WINDOW_SPECS } from "./config"
import { attachContextMenu } from "../copy"

const KINDS: WindowKind[] = ["main", "chat"]

/**
 * Creates and positions the windows: the toolbar (main) and the panel attached right under it
 * (window kind "chat": answers and live transcript as tabs). Settings live on the web dashboard.
 *
 * Events: "state" (WindowsState)
 */
export class WindowManager extends EventEmitter {
  private windows = new Map<WindowKind, BrowserWindow>()
  private stealth = true
  private quitting = false
  /** Visibility snapshot taken by hideAll so showAll can restore it. Non-null while everything is hidden. */
  private restoreSet: WindowKind[] | null = null
  private panelTab: PanelTab = "answers"
  /** Width added to the panel for the suggestions rail. */
  private panelExtra = 0

  constructor(private readonly preloadPath: string) {
    super()
    app.on("before-quit", () => {
      this.quitting = true
    })
  }

  setStealth(enabled: boolean): void {
    this.stealth = enabled
    for (const win of this.windows.values()) this.applyStealth(win)
  }

  get(kind: WindowKind): BrowserWindow | null {
    const win = this.windows.get(kind)
    return win && !win.isDestroyed() ? win : null
  }

  kindOf(contents: WebContents): WindowKind | null {
    for (const [kind, win] of this.windows) if (!win.isDestroyed() && win.webContents === contents) return kind
    return null
  }

  isVisible(kind: WindowKind): boolean {
    return this.get(kind)?.isVisible() ?? false
  }

  state(): WindowsState {
    return { chat: this.isVisible("chat"), panelTab: this.panelTab }
  }

  /** Show the panel on a tab (background: see show()). */
  showPanel(tab: PanelTab, opts: { background?: boolean } = {}): void {
    this.panelTab = tab
    this.send("chat", "panel:tab", tab)
    this.show("chat", opts)
    this.emitState()
  }

  /** Toolbar buttons: open the panel on a tab, or close it when that tab is already showing. */
  togglePanel(tab: PanelTab): void {
    if (!this.restoreSet && this.isVisible("chat") && this.panelTab === tab) this.hide("chat")
    else this.showPanel(tab)
  }

  /** The user switched tabs inside the panel. */
  setPanelTab(tab: PanelTab): void {
    this.panelTab = tab
    this.emitState()
  }

  /**
   * Widen or narrow the panel for the suggestions rail. The answers column keeps its width,
   * including one the user dragged, and the panel stays centered under the toolbar.
   */
  setPanelExtra(px: number): void {
    const delta = px - this.panelExtra
    if (delta === 0) return
    this.panelExtra = px
    const win = this.get("chat")
    if (!win) return
    const spec = WINDOW_SPECS.chat
    const b = win.getBounds()
    win.setMinimumSize(spec.minWidth + px, spec.minHeight)
    win.setMaximumSize(spec.maxWidth + px, spec.maxHeight)
    win.setBounds({ x: b.x - Math.round(delta / 2), y: b.y, width: b.width + delta, height: b.height })
    if (win.isVisible()) this.layoutChildren()
  }

  /** Create a window without showing it (the panel hosts audio capture, so it must exist while recording). */
  ensure(kind: WindowKind): void {
    if (!this.get(kind)) this.create(kind, this.positionFor(kind))
  }

  /** Create the toolbar. Child windows are created lazily on first show. */
  createMain(): BrowserWindow {
    const existing = this.get("main")
    if (existing) return existing
    const spec = WINDOW_SPECS.main
    const area = screen.getPrimaryDisplay().workArea
    const win = this.create("main", {
      x: Math.round(area.x + (area.width - spec.width) / 2),
      y: area.y + MAIN_TOP_MARGIN
    })
    win.on("close", (e) => {
      if (this.quitting) return
      e.preventDefault()
      this.hideAll()
    })
    win.on("moved", () => this.layoutChildren())
    win.on("resized", () => this.layoutChildren())
    win.once("ready-to-show", () => win.show())
    return win
  }

  /**
   * Show a window. While everything is hidden (toggleAll), a background request
   * (auto-answer posting to chat) must not pop a lone window back onto the screen:
   * it is queued for when the user unhides. An explicit request brings the whole
   * set back first, so there is never an orphan window without its toolbar.
   */
  show(kind: WindowKind, opts: { background?: boolean } = {}): void {
    if (this.restoreSet && kind !== "main") {
      if (opts.background) {
        if (!this.restoreSet.includes(kind)) this.restoreSet.push(kind)
        return
      }
      this.showAll()
    }
    let win = this.get(kind)
    if (!win) {
      win = this.create(kind, this.positionFor(kind))
      win.once("ready-to-show", () => this.reveal(kind))
      return
    }
    this.reveal(kind)
  }

  hide(kind: WindowKind): void {
    this.get(kind)?.hide()
    if (kind !== "main") this.layoutChildren()
    this.emitState()
  }

  toggle(kind: WindowKind): boolean {
    if (!this.restoreSet && this.isVisible(kind)) {
      this.hide(kind)
      return false
    }
    this.show(kind)
    return true
  }

  /** Hide everything, or bring back what was visible before. */
  toggleAll(): void {
    if (this.isVisible("main")) this.hideAll()
    else this.showAll()
  }

  hideAll(): void {
    this.restoreSet = KINDS.filter((k) => k !== "main" && this.isVisible(k))
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.hide()
    this.emitState()
  }

  showAll(): void {
    const restore = this.restoreSet ?? []
    this.restoreSet = null
    this.show("main")
    for (const kind of restore) this.show(kind)
  }

  moveMain(dx: number, dy: number): void {
    const main = this.get("main")
    if (!main) return
    const b = main.getBounds()
    const area = screen.getDisplayMatching(b).workArea
    main.setPosition(
      clamp(b.x + dx * MOVE_STEP, area.x, area.x + area.width - b.width),
      clamp(b.y + dy * MOVE_STEP, area.y, area.y + area.height - b.height)
    )
    this.layoutChildren()
  }

  centerMain(): void {
    const main = this.createMain()
    const b = main.getBounds()
    const area = screen.getPrimaryDisplay().workArea
    main.setPosition(Math.round(area.x + (area.width - b.width) / 2), area.y + MAIN_TOP_MARGIN)
    if (this.restoreSet) this.showAll()
    else this.show("main")
    this.layoutChildren()
  }

  /** Resize a window to its content, within the spec bounds. */
  fit(kind: WindowKind, width: number, height: number): void {
    const win = this.get(kind)
    if (!win) return
    const spec = WINDOW_SPECS[kind]
    const w = clamp(Math.ceil(width), spec.minWidth, spec.maxWidth)
    const h = clamp(Math.ceil(height), spec.minHeight, spec.maxHeight)
    const b = win.getBounds()
    if (Math.abs(b.width - w) < 2 && Math.abs(b.height - h) < 2) return
    if (kind === "main") {
      // Keep the toolbar centered on its own midpoint while it grows/shrinks.
      win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: b.y, width: w, height: h })
      this.layoutChildren()
    } else {
      win.setBounds({ x: b.x, y: b.y, width: w, height: h })
    }
  }

  /** Temporarily hide all windows (for a screen capture). Returns a restore function. */
  hideForCapture(): () => void {
    if (this.stealth) return () => {}
    const visible = KINDS.filter((k) => this.isVisible(k))
    for (const k of visible) this.get(k)?.hide()
    return () => {
      for (const k of visible) this.get(k)?.show()
    }
  }

  broadcast<K extends EventChannel>(channel: K, payload: EventMap[K]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  send<K extends EventChannel>(kind: WindowKind, channel: K, payload: EventMap[K]): void {
    this.get(kind)?.webContents.send(channel, payload)
  }

  destroyAll(): void {
    this.quitting = true
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy()
    this.windows.clear()
  }

  private create(kind: WindowKind, position: { x: number; y: number }): BrowserWindow {
    const spec = WINDOW_SPECS[kind]
    const extra = kind === "chat" ? this.panelExtra : 0
    const win = new BrowserWindow({
      ...position,
      width: spec.width + extra,
      height: spec.height,
      minWidth: spec.minWidth + extra,
      minHeight: spec.minHeight,
      maxWidth: spec.maxWidth + extra,
      maxHeight: spec.maxHeight,
      show: false,
      title: spec.decorated ? "Meetingly" : undefined,
      frame: spec.decorated,
      transparent: !spec.decorated,
      hasShadow: spec.decorated,
      backgroundColor: spec.decorated ? "#141416" : "#00000000",
      alwaysOnTop: !spec.decorated,
      fullscreenable: false,
      resizable: spec.resizable,
      movable: kind === "main" || spec.decorated,
      focusable: spec.focusable,
      skipTaskbar: true,
      acceptFirstMouse: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    win.setMenuBarVisibility(false)
    this.emit("created", kind, win.webContents)
    this.applyStealth(win)
    // Never navigate away or open popups from the renderer.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", (e) => e.preventDefault())
    attachContextMenu(win.webContents)

    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl) void win.loadURL(`${devUrl}#/${kind}`)
    else void win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `/${kind}` })

    if (spec.decorated) {
      // A decorated window has a real close button: closing must hide, not destroy.
      win.on("close", (e) => {
        if (this.quitting) return
        e.preventDefault()
        this.hide(kind)
      })
    }
    win.on("closed", () => {
      this.windows.delete(kind)
      if (kind === "main" && !this.quitting) this.destroyAll()
    })
    this.windows.set(kind, win)
    return win
  }

  private reveal(kind: WindowKind): void {
    const win = this.get(kind)
    if (!win) return
    // Decorated windows keep wherever the user last put them.
    if (kind !== "main" && !WINDOW_SPECS[kind].decorated) {
      const pos = this.positionFor(kind)
      win.setPosition(pos.x, pos.y)
    }
    win.show()
    if (WINDOW_SPECS[kind].focusable) win.focus()
    if (kind !== "main") this.layoutChildren()
    this.emitState()
  }

  private applyStealth(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    win.setContentProtection(this.stealth)
    win.setSkipTaskbar(true)
    const kind = this.kindOf(win.webContents)
    if (kind && WINDOW_SPECS[kind].decorated) return
    win.setAlwaysOnTop(true, "screen-saver")
    if (process.platform === "darwin") {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setHiddenInMissionControl(this.stealth)
    }
  }

  /** Where a child window belongs relative to the toolbar, clamped to the screen. */
  private positionFor(kind: WindowKind): { x: number; y: number } {
    const main = this.get("main")
    const spec = WINDOW_SPECS[kind]
    const area = main ? screen.getDisplayMatching(main.getBounds()).workArea : screen.getPrimaryDisplay().workArea
    if (!main || kind === "main") {
      return { x: Math.round(area.x + (area.width - spec.width) / 2), y: area.y + MAIN_TOP_MARGIN }
    }
    const m = main.getBounds()
    const size = this.get(kind)?.getBounds() ?? { width: spec.width + (kind === "chat" ? this.panelExtra : 0), height: spec.height }
    if (spec.decorated) {
      // First placement of a normal window: centered on the toolbar's display.
      return {
        x: Math.round(area.x + (area.width - size.width) / 2),
        y: Math.round(area.y + (area.height - size.height) / 2)
      }
    }
    // The panel: attached, centered under the toolbar with only a hairline seam.
    const x = m.x + (m.width - size.width) / 2
    const y = m.y + m.height - PANEL_OVERLAP
    return {
      x: Math.round(clamp(x, area.x, area.x + area.width - size.width)),
      y: Math.round(clamp(y, area.y, area.y + area.height - size.height))
    }
  }

  private layoutChildren(): void {
    for (const kind of KINDS) {
      if (kind === "main" || WINDOW_SPECS[kind].decorated) continue
      const win = this.get(kind)
      if (win && win.isVisible()) {
        const pos = this.positionFor(kind)
        const b = win.getBounds()
        if (b.x !== pos.x || b.y !== pos.y) win.setPosition(pos.x, pos.y)
      }
    }
  }

  private emitState(): void {
    this.emit("state", this.state())
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export type { Rectangle }
