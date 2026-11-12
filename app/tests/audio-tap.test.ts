import { describe, expect, it } from "vitest"
import { parseMonitors, splitSources } from "../electron/services/audioTap"

// Trimmed from `pactl list sources` on PipeWire: tab-indented fields, one block per source.
const LIST = `Source #67
\tState: SUSPENDED
\tName: alsa_output.pci-0000_09_00.4.analog-stereo.monitor
\tDescription: Monitor of Starship/Matisse HD Audio Controller Analog Stereo
\tMonitor of Sink: alsa_output.pci-0000_09_00.4.analog-stereo
Source #68
\tState: SUSPENDED
\tName: alsa_input.usb-Maono_DGM20_USB_Microphone_20230101-00.analog-stereo
\tDescription: DGM20 USB Microphone Analog Stereo
\tMonitor of Sink: n/a
Source #69
\tState: SUSPENDED
\tName: alsa_output.usb-Compx_G11_G112-00.analog-stereo.monitor
\tDescription: Monitor of G11 Analog Stereo
\tMonitor of Sink: alsa_output.usb-Compx_G11_G112-00.analog-stereo
Source #4245
\tState: SUSPENDED
\tName: meetingly_system
\tDescription: Meetingly system audio
\tMonitor of Sink: n/a
`

describe("splitSources", () => {
  it("gives one block per source, header dropped", () => {
    const blocks = splitSources(LIST)
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).not.toContain("Source #")
  })
})

describe("parseMonitors", () => {
  it("keeps the output monitors and drops microphones", () => {
    expect(parseMonitors(LIST)).toEqual([
      { id: "alsa_output.pci-0000_09_00.4.analog-stereo.monitor", label: "Monitor of Starship/Matisse HD Audio Controller Analog Stereo" },
      { id: "alsa_output.usb-Compx_G11_G112-00.analog-stereo.monitor", label: "Monitor of G11 Analog Stereo" }
    ])
  })

  it("hides the source the tap itself created, so the list does not grow every session", () => {
    expect(parseMonitors(LIST).some((m) => m.id === "meetingly_system")).toBe(false)
  })

  it("returns nothing when pactl printed no sources", () => {
    expect(parseMonitors("")).toEqual([])
    expect(parseMonitors("Failure: Connection refused\n")).toEqual([])
  })
})
