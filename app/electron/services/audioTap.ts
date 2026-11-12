import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AudioTap as Tap, MonitorSource } from "../../shared/types"
import { SYSTEM_AUDIO_TAP_LABEL } from "../../shared/types"

const run = promisify(execFile)

/** The virtual source the tap creates; fixed so a leftover from a crash can be found and reused. */
const SOURCE_NAME = "meetingly_system"
/** What Chromium shows as the device label, and how the renderer finds it (no spaces: see the type). */
const SOURCE_LABEL = SYSTEM_AUDIO_TAP_LABEL
const TAP_TIMEOUT_MS = 8000

/** Sources in `pactl list sources`, one block each (the "Source #12" header is dropped). */
export function splitSources(list: string): string[] {
  return list.split(/^Source #/m).slice(1)
}

/**
 * The monitor sources: PulseAudio and PipeWire put what a sink plays on a source of its own, marked
 * with "Monitor of Sink". Chromium does not list them, which is why they are read here instead.
 */
export function parseMonitors(list: string): MonitorSource[] {
  const monitors: MonitorSource[] = []
  for (const block of splitSources(list)) {
    const field = (name: string) => new RegExp(`^\\t${name}: (.+)$`, "m").exec(block)?.[1].trim()
    const sink = field("Monitor of Sink")
    const id = field("Name")
    if (!id || !sink || sink === "n/a" || id === SOURCE_NAME) continue
    monitors.push({ id, label: field("Description") || id })
  }
  return monitors
}

/** The first level in `pactl get-source-volume` ("front-left: 5140 / 8% / -66.33 dB"). */
export function parseVolume(text: string): string | null {
  return /(\d+)%/.exec(text)?.[0] ?? null
}

/**
 * Linux system audio. Chromium captures microphones only: `getDisplayMedia` hands back an audio track
 * that carries silence, and monitor sources are not in `enumerateDevices` at all. So the main process
 * asks PulseAudio for a remap source that mirrors the output's monitor — a normal input device, which
 * the panel can then capture like a microphone.
 */
export class SystemAudioTap {
  private module: string | null = null
  /** The monitor the current module mirrors, to reload it when the pick changes. */
  private master: string | null = null
  /** The monitor's own volume, which the tap borrows at 100% and gives back on stop. */
  private saved: { volume: string; muted: boolean } | null = null
  private readonly enabled = process.platform === "linux"

  /** The outputs the call can be read from, described as PulseAudio does ("Monitor of …"). */
  async monitors(): Promise<MonitorSource[]> {
    if (!this.enabled) return []
    const list = await this.ask(["list", "sources"])
    // No pactl, or no PulseAudio/PipeWire: the capture error names what to install.
    return list ? parseMonitors(list) : []
  }

  /** Route a monitor (empty: the default output's) into a source Chromium lists; null when it cannot. */
  async start(monitor: string): Promise<Tap | null> {
    if (!this.enabled) return null
    const master = monitor || (await this.defaultMonitor())
    if (!master) return null
    if (this.module && this.master === master) return { label: SOURCE_LABEL }
    await this.stop()
    this.module = (await this.existingModule()) ?? (await this.ask(["load-module", "module-remap-source", `master=${master}`, `source_name=${SOURCE_NAME}`, `source_properties=device.description=${SOURCE_LABEL}`]))
    if (!this.module) return null
    this.master = master
    await this.boost(master)
    return { label: SOURCE_LABEL }
  }

  async stop(): Promise<void> {
    const module = this.module
    const master = this.master
    const saved = this.saved
    this.module = null
    this.master = null
    this.saved = null
    if (module) await this.ask(["unload-module", module])
    if (master && saved) {
      // A muted or quiet monitor would have been recorded as silence: put the user's levels back.
      if (saved.volume !== "100%") await this.ask(["set-source-volume", master, saved.volume])
      if (saved.muted) await this.ask(["set-source-mute", master, "1"])
    }
  }

  /**
   * The remap source carries the monitor at the monitor's own volume, and a monitor left at 8% records
   * as silence. Raise it for the session — the monitor is not what the user hears, so nothing gets louder.
   */
  private async boost(master: string): Promise<void> {
    const volume = await this.ask(["get-source-volume", master])
    const muted = await this.ask(["get-source-mute", master])
    const level = volume ? parseVolume(volume) : null
    if (!level) return
    this.saved = { volume: level, muted: Boolean(muted?.trim().toLowerCase().endsWith("yes")) }
    if (level !== "100%") await this.ask(["set-source-volume", master, "100%"])
    if (this.saved.muted) await this.ask(["set-source-mute", master, "0"])
  }

  /** A module left over from a crash is reused: its id is not known, only that the source exists. */
  private async existingModule(): Promise<string | null> {
    const modules = await this.ask(["list", "short", "modules"])
    const line = modules?.split("\n").find((l) => l.includes("module-remap-source") && l.includes(`source_name=${SOURCE_NAME}`))
    return line?.split("\t")[0]?.trim() || null
  }

  /** The monitor of the sink the user hears the call on. */
  private async defaultMonitor(): Promise<string | null> {
    const sink = (await this.ask(["get-default-sink"]))?.trim()
    return sink ? `${sink}.monitor` : null
  }

  /** One pactl call; null when pactl is missing, the sound server is down, or it refused. */
  private async ask(args: string[]): Promise<string | null> {
    try {
      const { stdout } = await run("pactl", args, { timeout: TAP_TIMEOUT_MS })
      return stdout.trim()
    } catch {
      return null
    }
  }
}
