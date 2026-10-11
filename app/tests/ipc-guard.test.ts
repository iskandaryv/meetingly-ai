import { describe, expect, it } from "vitest"
import { rendererSettingsPatch, trustedFrame } from "../electron/ipc/guard"

describe("IPC boundaries", () => {
  it("refuses subframes, missing frames and unowned renderers", () => {
    const main = {}
    expect(trustedFrame(true, main, main)).toBe(true)
    expect(trustedFrame(false, main, main)).toBe(false)
    expect(trustedFrame(true, {}, main)).toBe(false)
    expect(trustedFrame(true, null, null)).toBe(false)
  })
  it("preserves user preferences without allowing credential or device replacement", () => {
    expect(rendererSettingsPatch({ outputLanguage: "ru", suggestions: false, cloud: { token: "attacker" },
      deviceId: "replacement", ownKey: { baseUrl: "https://example.invalid" }, unexpected: true }))
      .toEqual({ outputLanguage: "ru", suggestions: false })
  })
  it("rejects malformed patch containers", () => {
    for (const input of [null, false, "text", []]) expect(() => rendererSettingsPatch(input)).toThrow()
  })
  it("rejects non-boolean native preferences before they can be saved", () => {
    for (const key of ["autoLaunch", "stealth", "suggestions"]) {
      expect(() => rendererSettingsPatch({ [key]: "yes" })).toThrow("expected a boolean")
    }
    expect(rendererSettingsPatch({ autoLaunch: false })).toEqual({ autoLaunch: false })
  })
})
