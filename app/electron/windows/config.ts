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
  /** Receives keyboard focus. The toolbar does not, so it never steals focus from the meeting app. */
  focusable: boolean
  /**
   * Frameless glass panels hang off the toolbar. A decorated window is a normal
   * OS window (title bar, movable, resizable) that the user places wherever they like.
   */
  decorated: boolean
}

/** One place for every window's dimensions. The renderer asks to be fitted within these. */
export const WINDOW_SPECS: Record<WindowKind, WindowSpec> = {
  main: { width: 360, height: 44, minWidth: 200, minHeight: 32, maxWidth: 900, maxHeight: 120, resizable: false, focusable: false, decorated: false },
  // The attached panel: answers and live transcript as tabs, directly under the toolbar.
  chat: { width: 528, height: 380, minWidth: 380, minHeight: 220, maxWidth: 900, maxHeight: 800, resizable: true, focusable: true, decorated: false }
}

/** The suggestions rail on the left of the panel; the panel widens by this while it shows. */
export const SUGGESTIONS_WIDTH = 200
/** The panel tucks under the toolbar: each window has a 4 px transparent margin, so this leaves a 4 px seam. */
export const PANEL_OVERLAP = 4
export const MAIN_TOP_MARGIN = 40
export const MOVE_STEP = 48
