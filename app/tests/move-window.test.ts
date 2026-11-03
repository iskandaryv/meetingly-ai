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
  screen: { dipToScreenPoint: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  native.setWindowPos.mockReturnValue(true)
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
})
