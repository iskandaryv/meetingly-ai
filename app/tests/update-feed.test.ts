import { describe, expect, it } from "vitest"
import { isNewer, macZipFor, parseFeed, shellQuote } from "../electron/update-feed"

// What electron-builder wrote for the 1.1.0 Mac build.
const LATEST_MAC = `version: 1.1.0
files:
  - url: Meetingly-1.1.0-x64.zip
    sha512: aAYq5TUYNajETm3w/eKxrC5cKmRoWQGEIRid4neEAhysiSQewWbAkIea6vmNTmFYGO9iLqO6hVeabV8P6Dg4Fw==
    size: 151602781
  - url: Meetingly-1.1.0-arm64.zip
    sha512: kDRywaoiu1Kc4aVsgJzXVGC74AwYc7Es4kLp/3wNSJ+jh6Wnjfe5kqU44uHg4magZHN56fsf3tCqzfnQRrtZuA==
    size: 146361991
  - url: Meetingly-1.1.0-x64.dmg
    sha512: db8mHMme0bAjUn3BckfkySCD0WYwOxe+NH9PAK0RBRFvXRnQYKXSvHFzO65qQn8IFy1HyU1wZyLyGvUn1emz+w==
    size: 151490176
    blockMapSize: 163412
path: Meetingly-1.1.0-x64.zip
sha512: aAYq5TUYNajETm3w/eKxrC5cKmRoWQGEIRid4neEAhysiSQewWbAkIea6vmNTmFYGO9iLqO6hVeabV8P6Dg4Fw==
releaseDate: '2026-10-04T10:11:26.336Z'
`

describe("update feed", () => {
  it("reads the version and every file", () => {
    const feed = parseFeed(LATEST_MAC)!
    expect(feed.version).toBe("1.1.0")
    expect(feed.files).toHaveLength(3)
    expect(feed.files[1]).toEqual({ url: "Meetingly-1.1.0-arm64.zip", sha512: expect.stringMatching(/^kDRy.*==$/), size: 146361991 })
    expect(parseFeed(LATEST_MAC.replace(/\n/g, "\r\n"))!.files).toHaveLength(3)
    expect(parseFeed("nothing here")).toBeNull()
  })

  it("picks the zip for Apple Silicon or Intel", () => {
    const feed = parseFeed(LATEST_MAC)!
    expect(macZipFor(feed, "arm64")?.url).toBe("Meetingly-1.1.0-arm64.zip")
    expect(macZipFor(feed, "x64")?.url).toBe("Meetingly-1.1.0-x64.zip")
    expect(macZipFor({ version: "1", files: [] }, "arm64")).toBeNull()
  })

  it("compares versions", () => {
    expect(isNewer("1.1.1", "1.1.0")).toBe(true)
    expect(isNewer("1.10.0", "1.9.9")).toBe(true)
    expect(isNewer("1.1.0", "1.1.0")).toBe(false)
    expect(isNewer("1.0.9", "1.1.0")).toBe(false)
    expect(isNewer("1.2.0", "1.2.0-beta.3")).toBe(true)
    expect(isNewer("1.2.0-beta.3", "1.2.0")).toBe(false)
    expect(isNewer("1.2.0-beta.10", "1.2.0-beta.9")).toBe(true)
    expect(isNewer("v2.0.0", "1.9.0")).toBe(true)
  })

  it("quotes paths for the install script", () => {
    expect(shellQuote("/Users/a b/Library/Application Support/Meetingly")).toBe("'/Users/a b/Library/Application Support/Meetingly'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})
