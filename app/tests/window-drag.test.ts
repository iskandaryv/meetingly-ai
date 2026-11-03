import { screen } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WindowManager } from "../electron/windows/WindowManager"

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  screen: {
    getCursorScreenPoint: vi.fn(),
    getDisplayNearestPoint: vi.fn(),
    getDisplayMatching: vi.fn()
  }
}))
vi.mock("../electron/copy", () => ({ attachContextMenu: vi.fn() }))

const workArea = { x: 0, y: 0, width: 1200, height: 900 }

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
  vi.mocked(screen.getDisplayNearestPoint).mockReturnValue({ workArea } as ReturnType<typeof screen.getDisplayNearestPoint>)
  vi.mocked(screen.getDisplayMatching).mockReturnValue({ workArea } as ReturnType<typeof screen.getDisplayMatching>)
})

describe("dragging the attached panel", () => {
  it.each([
    { dpi: "100%", rendererDx: 100, rendererDy: 70 },
    { dpi: "150%", rendererDx: 150, rendererDy: 105 }
  ])("moves the toolbar using DIP, not renderer pixels at $dpi", ({ rendererDx, rendererDy }) => {
    vi.mocked(screen.getCursorScreenPoint)
      .mockReturnValueOnce({ x: 400, y: 300 })
      .mockReturnValueOnce({ x: 500, y: 370 })
    const { manager, bounds } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", rendererDx, rendererDy)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 350, y: 270 })
  })

  it("keeps the toolbar on the current display when the cursor moves outside", () => {
    vi.mocked(screen.getCursorScreenPoint)
      .mockReturnValueOnce({ x: 400, y: 300 })
      .mockReturnValueOnce({ x: 1800, y: 1300 })
    const { manager, bounds } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 1400, 1000)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 900, y: 856 })
  })

  it("keeps renderer offsets as a fallback when native cursor access is unavailable", () => {
    vi.mocked(screen.getCursorScreenPoint).mockImplementation(() => { throw new Error("cursor unavailable") })
    const { manager, bounds } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 100, 70)
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 350, y: 270 })
  })

  it("stops moving after the drag ends", () => {
    vi.mocked(screen.getCursorScreenPoint)
      .mockReturnValueOnce({ x: 400, y: 300 })
      .mockReturnValueOnce({ x: 500, y: 370 })
    const { manager, window } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("end", 0, 0)
    manager.dragMain("move", 100, 70)
    expect(window.setBounds).not.toHaveBeenCalled()
  })

  it("preserves the toolbar dimensions across repeated drag events", () => {
    vi.mocked(screen.getCursorScreenPoint)
      .mockReturnValueOnce({ x: 400, y: 300 })
      .mockReturnValueOnce({ x: 450, y: 320 })
      .mockReturnValueOnce({ x: 500, y: 370 })
    const { manager, bounds, window } = toolbar()
    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 50, 20)
    // Simulate an OS-level sizing anomaly during the drag.
    Object.assign(bounds, { width: 310, height: 50 })
    manager.dragMain("move", 100, 70)
    expect(window.setBounds).toHaveBeenCalledTimes(2)
    expect({ width: bounds.width, height: bounds.height }).toEqual({ width: 300, height: 44 })
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 350, y: 270 })
  })

  it("moves the attached panel without changing its size", () => {
    vi.mocked(screen.getCursorScreenPoint)
      .mockReturnValueOnce({ x: 400, y: 300 })
      .mockReturnValueOnce({ x: 450, y: 320 })
    const { manager } = toolbar()
    const childBounds = { x: 136, y: 240, width: 528, height: 380 }
    const child = {
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ ...childBounds }),
      setBounds: vi.fn((next: Partial<typeof childBounds>) => Object.assign(childBounds, next))
    }
    ;(manager as unknown as { windows: Map<string, unknown> }).windows.set("chat", child)

    manager.dragMain("start", 0, 0)
    manager.dragMain("move", 50, 20)
    expect(child.setBounds).toHaveBeenCalledWith({ x: 186, y: 260, width: 528, height: 380 })
    expect(childBounds).toEqual({ x: 186, y: 260, width: 528, height: 380 })
  })
})
