import { screen, type BrowserWindow } from "electron"
import koffi from "koffi"

// SetWindowPos changes only the physical position. Electron's DIP bounds round-tripping
// can grow frameless windows by a pixel on every move at fractional Windows DPI scales.
const SWP_NOSIZE = 0x0001
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_NOOWNERZORDER = 0x0200
const FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER

const setWindowPos = process.platform === "win32"
  ? koffi.load("user32.dll").func("bool __stdcall SetWindowPos(void *hwnd, void *insertAfter, int x, int y, int width, int height, unsigned int flags)")
  : null

/** Move without resizing, while keeping the coordinates and layout in Electron DIP units. */
export function moveWindow(win: BrowserWindow, x: number, y: number): void {
  x = Math.round(x)
  y = Math.round(y)
  if (!setWindowPos) {
    const bounds = win.getBounds()
    win.setBounds({ ...bounds, x, y })
    return
  }

  // For points outside every display, dipToScreenPoint can fall back to the primary
  // monitor's scale, causing a jump when a window leaves a secondary mixed-DPI display.
  // Anchor off-screen conversion to the window's current display instead.
  const insideDisplay = screen.getAllDisplays().some(({ bounds }) =>
    x >= bounds.x && x < bounds.x + bounds.width &&
    y >= bounds.y && y < bounds.y + bounds.height
  )
  const physical = insideDisplay
    ? screen.dipToScreenPoint({ x, y })
    : screen.dipToScreenRect(win, { x, y, width: 0, height: 0 })
  const hwnd = koffi.decode(win.getNativeWindowHandle(), "void *")
  if (!setWindowPos(hwnd, null, physical.x, physical.y, 0, 0, FLAGS)) {
    throw new Error("Could not move Meetingly window (SetWindowPos failed)")
  }
}
