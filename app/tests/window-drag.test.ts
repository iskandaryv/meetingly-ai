import { screen } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WindowManager } from "../electron/windows/WindowManager"
import { moveWindow } from "../electron/windows/moveWindow"

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  screen: { getDisplayMatching: vi.fn(), getCursorScreenPoint: vi.fn() }
}))
vi.mock("../electron/copy", () => ({ attachContextMenu: vi.fn() }))
vi.mock("../electron/windows/moveWindow", () => ({
  // Stand-in for the Win32 position-only move (without invoking Electron's resizing APIs).
  moveWindow: vi.fn((win: { setPosition: (x: number, y: number) => void }, x: number, y: number) => win.setPosition(x, y))
}))

function toolbar() {
  const bounds = { x: 250, y: 200, width: 300, height: 44 }
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: vi.fn((next: Partial<typeof bounds>) => Object.assign(bounds, next)),
    setPosition: vi.fn((x: number, y: number) => Object.assign(bounds, { x, y }))
  }
  const manager = new WindowManager("")
  ;(manager as unknown as { windows: Map<string, unknown> }).windows.set("main", window)
  return { manager, bounds, window }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(screen.getDisplayMatching).mockReturnValue({
    workArea: { x: 0, y: 0, width: 1200, height: 900 }
  } as ReturnType<typeof screen.getDisplayMatching>)
})

describe("dragging the attached panel", () => {
  it("allows keyboard movement beyond the work area without resizing", () => {
    const { manager, bounds } = toolbar()
    manager.moveMain(20, 20)
    expect(bounds).toEqual({ x: 1210, y: 1160, width: 300, height: 44 })
    manager.moveMain(-20, -20)
    expect(bounds).toEqual({ x: 250, y: 200, width: 300, height: 44 })
  })

  it.each([
    { dpi: "100%", rendererDx: 100, rendererDy: 70 },
    { dpi: "125%", rendererDx: 100, rendererDy: 70 },
    { dpi: "150%", rendererDx: 100, rendererDy: 70 },
    { dpi: "175%", rendererDx: 100, rendererDy: 70 }
  ])("moves by the event-time DIP delta at $dpi", ({ rendererDx, rendererDy }) => {
    const { manager, bounds } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", rendererDx, rendererDy)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 350, y: 270 })
  })

  it("allows the toolbar to move beyond the screen without clamping", () => {
    const { manager, bounds } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 1400, 1000)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 1650, y: 1200 })
  })

  it("preserves the entire movement when the main process handles drag start late", () => {
    vi.mocked(screen.getCursorScreenPoint).mockImplementation(() => { throw new Error("Cursor moved after release") })
    const { manager, bounds } = toolbar()
    // The pointer can already be at an unrelated position when these queued IPC events execute.
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 100, 70)
    manager.dragMain("end", 0, 0)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 350, y: 270 })
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
  })

  it("stops moving after the drag ends", () => {
    const { manager } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("end", 0, 0)
    manager.dragMain("move", 100, 70)
    expect(moveWindow).not.toHaveBeenCalled()
  })

  it("moves repeatedly without reading or writing window sizes", () => {
    const { manager, bounds, window } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 50, 20)
    manager.dragMain("move", 100, 70)
    expect(moveWindow).toHaveBeenCalledTimes(2)
    expect(window.setBounds).not.toHaveBeenCalled()
    expect({ width: bounds.width, height: bounds.height }).toEqual({ width: 300, height: 44 })
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 350, y: 270 })
  })

  it("moves the attached panel without changing its size", () => {
    const { manager } = toolbar()
    const childBounds = { x: 136, y: 240, width: 528, height: 380 }
    const child = {
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ ...childBounds }),
      setPosition: vi.fn((x: number, y: number) => Object.assign(childBounds, { x, y }))
    }
    ;(manager as unknown as { windows: Map<string, unknown> }).windows.set("chat", child)

    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 50, 20)
    expect(child.setPosition).toHaveBeenCalledWith(186, 260)
    expect(childBounds).toEqual({ x: 186, y: 260, width: 528, height: 380 })
  })

  it("keeps the panel attached when dragged beyond an edge and back again", () => {
    const { manager, bounds } = toolbar()
    const childBounds = { x: 136, y: 240, width: 528, height: 380 }
    const child = {
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ ...childBounds }),
      setPosition: vi.fn((x: number, y: number) => Object.assign(childBounds, { x, y }))
    }
    ;(manager as unknown as { windows: Map<string, unknown> }).windows.set("chat", child)

    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 1400, 1000)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 1650, y: 1200 })
    expect(childBounds).toEqual({ x: 1536, y: 1240, width: 528, height: 380 })

    manager.dragMain("move", 50, 50)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 300, y: 250 })
    expect(childBounds).toEqual({ x: 186, y: 290, width: 528, height: 380 })
    manager.dragMain("end", 0, 0)
  })
})
