import { screen } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { moveWindow } from "../electron/windows/moveWindow"

const native = vi.hoisted(() => ({
  setWindowPos: vi.fn(() => true),
  decode: vi.fn(() => "native-window-handle")
}))

vi.mock("koffi", () => ({
  default: {
    load: vi.fn(() => ({ func: () => native.setWindowPos })),
    decode: native.decode
  }
}))
vi.mock("electron", () => ({
  screen: { dipToScreenPoint: vi.fn(), dipToScreenRect: vi.fn(), getAllDisplays: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  native.setWindowPos.mockReturnValue(true)
  vi.mocked(screen.getAllDisplays).mockReturnValue([
    { bounds: { x: 0, y: 0, width: 2000, height: 1200 }, scaleFactor: 1 } as never
  ])
})

describe.skipIf(process.platform !== "win32")("native Windows window movement", () => {
  it.each([1, 1.25, 1.5, 1.75, 2])("keeps its physical size unchanged at %sx DPI", (scale) => {
    vi.mocked(screen.dipToScreenPoint).mockImplementation(({ x, y }) => ({
      x: Math.round(x * scale), y: Math.round(y * scale)
    }))
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(0x1234n)
    const window = {
      getNativeWindowHandle: vi.fn(() => handle),
      setBounds: vi.fn(),
      setPosition: vi.fn()
    }

    moveWindow(window as never, 123, 67)
    expect(screen.dipToScreenPoint).toHaveBeenCalledWith({ x: 123, y: 67 })
    expect(native.decode).toHaveBeenCalledWith(handle, "void *")
    // SWP_NOSIZE (0x1) forbids changing dimensions; 0x4, 0x10, 0x200 preserve
    // z-order, activation, and owner z-order. Both size arguments remain zero.
    expect(native.setWindowPos).toHaveBeenCalledWith(
      "native-window-handle", null, Math.round(123 * scale), Math.round(67 * scale), 0, 0, 0x215
    )
    expect(window.setBounds).not.toHaveBeenCalled()
    expect(window.setPosition).not.toHaveBeenCalled()
  })

  it("fails explicitly when SetWindowPos refuses a move", () => {
    native.setWindowPos.mockReturnValue(false)
    vi.mocked(screen.dipToScreenPoint).mockReturnValue({ x: 10, y: 20 })
    const window = { getNativeWindowHandle: () => Buffer.alloc(8) }
    expect(() => moveWindow(window as never, 10, 20)).toThrow("SetWindowPos failed")
  })

  it("keeps moving beyond a secondary mixed-DPI display instead of jumping to primary scale", () => {
    vi.mocked(screen.getAllDisplays).mockReturnValue([
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { bounds: { x: 1920, y: 0, width: 640, height: 720 }, scaleFactor: 1.5 }
    ] as never)
    // Inside the secondary display, the point API uses its 150% scaling;
    // just outside it, that API would incorrectly fall back to the 100% primary.
    vi.mocked(screen.dipToScreenPoint).mockImplementation(({ x, y }) =>
      x < 2560 ? { x: 1920 + Math.round((x - 1920) * 1.5), y: Math.round(y * 1.5) } : { x, y }
    )
    vi.mocked(screen.dipToScreenRect).mockImplementation((window, rect) => ({
      ...rect,
      // The target display is 150%, but an unchanged window on the 100%
      // primary display would still use scale 1 if passed instead of null.
      x: 1920 + Math.round((rect.x - 1920) * (window === null ? 1.5 : 1)),
      y: Math.round(rect.y * (window === null ? 1.5 : 1))
    }))
    const win = { getNativeWindowHandle: () => Buffer.alloc(8) }

    moveWindow(win as never, 2559, 100)
    moveWindow(win as never, 2560, 100)
    moveWindow(win as never, 2600, 100)
    const nativeXs = (native.setWindowPos.mock.calls as unknown as unknown[][]).map((args) => args[2])
    expect(nativeXs).toEqual([2879, 2880, 2940])
    expect(screen.dipToScreenPoint).toHaveBeenCalledTimes(1)
    expect(screen.dipToScreenRect).toHaveBeenCalledTimes(2)
    expect(screen.dipToScreenRect).toHaveBeenCalledWith(null, { x: 2560, y: 100, width: 0, height: 0 })
  })

  it("selects the target display when jumping directly from primary beyond secondary", () => {
    vi.mocked(screen.getAllDisplays).mockReturnValue([
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { bounds: { x: 1920, y: 0, width: 640, height: 720 }, scaleFactor: 1.5 }
    ] as never)
    vi.mocked(screen.dipToScreenRect).mockImplementation((window, rect) => ({
      ...rect,
      x: 1920 + Math.round((rect.x - 1920) * (window === null ? 1.5 : 1)),
      y: Math.round(rect.y * (window === null ? 1.5 : 1))
    }))
    const win = { getNativeWindowHandle: () => Buffer.alloc(8) }

    // The window is still on the 100% primary display at the instant of this call.
    moveWindow(win as never, 2600, 100)

    expect(screen.dipToScreenRect).toHaveBeenCalledWith(null, { x: 2600, y: 100, width: 0, height: 0 })
    expect(native.setWindowPos).toHaveBeenCalledWith(
      "native-window-handle", null, 2940, 150, 0, 0, 0x215
    )
    expect(screen.dipToScreenPoint).not.toHaveBeenCalled()
  })
})
