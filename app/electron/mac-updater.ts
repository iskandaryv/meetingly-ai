import { app } from "electron"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { isNewer, macZipFor, parseFeed, shellQuote } from "./update-feed"

const run = promisify(execFile)

export interface MacUpdate {
  version: string
  /** The unpacked Meetingly.app, ready to take the installed one's place. */
  app: string
}

/**
 * Updates for the Mac build without Apple's updater, which only accepts apps signed with a paid
 * Developer ID. It reads latest-mac.yml, downloads the zip for this Mac, checks its sha512, unpacks it
 * with ditto, and installs by swapping the .app bundle in place: a small shell script waits for this
 * process to exit, moves the new bundle in and (optionally) opens it. Downloaded by the app itself, the
 * new bundle carries no quarantine flag, so macOS doesn't ask "Open Anyway" again.
 */
export class MacUpdater {
  private readonly dir = path.join(app.getPath("userData"), "update")

  constructor(private readonly feedUrl: string) {}

  /**
   * The installed bundle (…/Meetingly.app), or null when it can't be replaced in place: run from the dmg,
   * moved by macOS to a random read-only path (App Translocation), or in a folder this user can't write.
   */
  bundlePath(): string | null {
    const bundle = path.resolve(process.execPath, "../../..")
    if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) return null
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
      fs.accessSync(bundle, fs.constants.W_OK)
      return bundle
    } catch {
      return null
    }
  }

  /** An update downloaded earlier (this session or a previous one) and still newer than this version. */
  ready(): MacUpdate | null {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, "ready.json"), "utf8")) as MacUpdate
      return meta && isNewer(meta.version, app.getVersion()) && fs.existsSync(meta.app) ? meta : null
    } catch {
      return null
    }
  }

  /** Checks the feed and, when there is a newer version, downloads and unpacks it. */
  async fetchUpdate(): Promise<MacUpdate | null> {
    const ready = this.ready()
    if (ready) return ready
    const res = await fetch(`${this.feedUrl}/latest-mac.yml?t=${Date.now()}`)
    if (!res.ok) throw new Error(`latest-mac.yml: HTTP ${res.status}`)
    const feed = parseFeed(await res.text())
    if (!feed || !isNewer(feed.version, app.getVersion())) return null
    const file = macZipFor(feed, process.arch)
    if (!file) throw new Error(`latest-mac.yml has no ${process.arch} build`)

    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(this.dir, { recursive: true })
    const zip = path.join(this.dir, "update.zip")
    const download = await fetch(`${this.feedUrl}/${encodeURIComponent(file.url)}`)
    if (!download.ok || !download.body) throw new Error(`${file.url}: HTTP ${download.status}`)
    const hash = createHash("sha512")
    const out = fs.createWriteStream(zip)
    for await (const chunk of download.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      if (!out.write(chunk)) await once(out, "drain")
    }
    out.end()
    await once(out, "finish")
    if (hash.digest("base64") !== file.sha512) throw new Error(`${file.url}: checksum mismatch`)

    const unpacked = path.join(this.dir, "unpacked")
    await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked])
    fs.rmSync(zip, { force: true })
    const name = fs.readdirSync(unpacked).find((n) => n.endsWith(".app"))
    if (!name) throw new Error(`${file.url}: no .app inside`)
    const update = { version: feed.version, app: path.join(unpacked, name) }
    await run("/usr/bin/xattr", ["-cr", update.app]).catch(() => undefined)
    fs.writeFileSync(path.join(this.dir, "ready.json"), JSON.stringify(update))
    return update
  }

  /**
   * Hands the swap to a detached script that runs once this process has exited. False (nothing done)
   * when the installed bundle can't be replaced in place.
   */
  install(update: MacUpdate, relaunch: boolean): boolean {
    const bundle = this.bundlePath()
    if (!bundle) return false
    const b = shellQuote(bundle)
    const n = shellQuote(update.app)
    const script = path.join(this.dir, "install.sh")
    fs.writeFileSync(
      script,
      [
        "#!/bin/sh",
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
        `B=${b}; N=${n}; OLD="$B.old-$$"`,
        // Keep the old bundle until the new one is in place, so a failed move never leaves nothing.
        `if mv "$B" "$OLD" && mv "$N" "$B"; then rm -rf "$OLD" ${shellQuote(this.dir)}; elif [ -d "$OLD" ] && [ ! -d "$B" ]; then mv "$OLD" "$B"; fi`,
        relaunch ? `open "$B"` : "",
        ""
      ].join("\n")
    )
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref()
    return true
  }
}
