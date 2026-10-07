import type { WindowKind } from "../../shared/types"

export interface WindowSpec {
  width: number
  height: number
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
  /** Can the user resize it by dragging the edge? */
  resizable: boolean
  /** Can receive keyboard focus (and be activated by a click). */
  focusable: boolean
  /**
   * Frameless glass panels hang off the toolbar. A decorated window is a normal
   * OS window (title bar, movable, resizable) that the user places wherever they like.
   */
  decorated: boolean
}

/** One place for every window's dimensions. The renderer asks to be fitted within these. */
export const WINDOW_SPECS: Record<WindowKind, WindowSpec> = {
  // The toolbar is shown without being activated (WindowManager), so showing it never takes focus from the meeting
  // app. On Windows it must still be focusable: Chromium eats every click on a window that can't be activated
  // whenever Windows asks to activate it (WM_MOUSEACTIVATE → MA_NOACTIVATEANDEAT), which starts after the window has
  // been hidden and shown once, so after hide and unhide none of its buttons worked.
  main: { width: 360, height: 44, minWidth: 200, minHeight: 32, maxWidth: 900, maxHeight: 120, resizable: false, focusable: process.platform === "win32", decorated: false },
  // The attached panel: answers and live transcript as tabs, directly under the toolbar.
  chat: { width: 528, height: 380, minWidth: 380, minHeight: 220, maxWidth: 900, maxHeight: 800, resizable: true, focusable: true, decorated: false }
}

/** The suggestions rail on the left of the panel; the panel widens by this while it shows. */
export const SUGGESTIONS_WIDTH = 200
/** The panel tucks under the toolbar: each window has a 4 px transparent margin, so this leaves a 4 px seam. */
export const PANEL_OVERLAP = 4
export const MAIN_TOP_MARGIN = 40
export const MOVE_STEP = 48
