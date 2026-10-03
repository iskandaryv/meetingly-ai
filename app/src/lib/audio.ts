import type { AudioSource } from "@shared/types"
import { api, log } from "./api"

export interface AudioLevels {
  /** 0..1 RMS of the microphone input, null when not captured. */
  microphone: number | null
  /** 0..1 RMS of the system-audio input, null when not captured. */
  system: number | null
}

export interface AudioCapture {
  stop(): void
  /** Non-fatal problems, e.g. system audio unavailable while the mic still works. */
  warnings: string[]
}

export interface AudioInputDevice {
  id: string
  label: string
  /** PulseAudio / PipeWire "Monitor of …" sources carry system audio on Linux. */
  isMonitor: boolean
}

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096
const LEVEL_INTERVAL_MS = 120

/**
 * Capture audio and deliver 16 kHz stereo PCM16 chunks, interleaved: left = microphone
 * (you), right = system audio (them). Keeping the two apart lets on-device transcription
 * label who said what; cloud transcription mixes them back down in the main process.
 *
 * "microphone": the default or chosen input device (also how BlackHole on macOS
 *               and "Monitor of …" devices on Linux are used).
 * "system":     what the user hears. Windows: Chromium loopback. macOS 13+: CoreAudio
 *               tap through the same API. Falls back to the legacy desktop constraint.
 * "both":       the two, one per channel. A source that is not captured stays silent.
 */
export async function startAudioCapture(
  source: AudioSource,
  deviceId: string,
  onChunk: (pcm16: ArrayBuffer) => void,
  onLevels?: (levels: AudioLevels) => void
): Promise<AudioCapture> {
  const warnings: string[] = []
  const streams: { kind: "microphone" | "system"; stream: MediaStream }[] = []

  if (source === "microphone" || source === "both") {
    try {
      streams.push({ kind: "microphone", stream: await getMicrophoneStream(deviceId) })
    } catch (err) {
      if (source === "microphone") throw err
      warnings.push((err as Error).message)
    }
  }
  if (source === "system" || source === "both") {
    try {
      const stream = await getSystemStream()
      // Display-media requests carry a video track we never use.
      stream.getVideoTracks().forEach((t) => t.stop())
      streams.push({ kind: "system", stream })
    } catch (err) {
      if (source === "system" || streams.length === 0) throw err
      warnings.push((err as Error).message)
    }
  }
  if (streams.length === 0) throw new Error("No audio source could be opened")
  log("info", "audio", "capture started", {
    requested: source,
    opened: streams.map((s) => s.kind),
    tracks: streams.map((s) => ({ kind: s.kind, label: s.stream.getAudioTracks()[0]?.label ?? "?" })),
    warnings
  })

  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  // Two inputs, one per speaker side, sample-aligned by the merger.
  const merger = context.createChannelMerger(2)
  const processor = context.createScriptProcessor(BUFFER_SIZE, 2, 1)
  merger.connect(processor)
  // Keeps the processor alive without producing audible output.
  const sink = context.createGain()
  sink.gain.value = 0

  const analysers: Partial<Record<"microphone" | "system", AnalyserNode>> = {}
  const nodes: AudioNode[] = []
  for (const { kind, stream } of streams) {
    const input = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    // Merger inputs are mono: a stereo loopback stream is downmixed into its channel.
    input.connect(merger, 0, kind === "microphone" ? 0 : 1)
    input.connect(analyser)
    analysers[kind] = analyser
    nodes.push(input, analyser)
  }

  const toInt16 = (v: number) => {
    const s = Math.max(-1, Math.min(1, v))
    return s < 0 ? s * 0x8000 : s * 0x7fff
  }
  processor.onaudioprocess = (event) => {
    const mic = event.inputBuffer.getChannelData(0)
    const sys = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : null
    const pcm = new Int16Array(mic.length * 2)
    for (let i = 0; i < mic.length; i++) {
      pcm[2 * i] = toInt16(mic[i])
      pcm[2 * i + 1] = sys ? toInt16(sys[i]) : 0
    }
    onChunk(pcm.buffer)
  }
  processor.connect(sink)
  sink.connect(context.destination)

  let levelTimer: ReturnType<typeof setInterval> | null = null
  if (onLevels) {
    const buffer = new Float32Array(512)
    const rms = (analyser?: AnalyserNode): number | null => {
      if (!analyser) return null
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
      return Math.min(1, Math.sqrt(sum / buffer.length) * 4)
    }
    levelTimer = setInterval(() => onLevels({ microphone: rms(analysers.microphone), system: rms(analysers.system) }), LEVEL_INTERVAL_MS)
  }

  return {
    warnings,
    stop() {
      log("info", "audio", "capture stopped", { requested: source })
      if (levelTimer) clearInterval(levelTimer)
      processor.onaudioprocess = null
      processor.disconnect()
      merger.disconnect()
      sink.disconnect()
      nodes.forEach((n) => n.disconnect())
      streams.forEach(({ stream }) => stream.getTracks().forEach((t) => t.stop()))
      void context.close()
    }
  }
}

/** Input devices with readable labels. Asks for mic permission once so labels are populated. */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  let devices = await navigator.mediaDevices.enumerateDevices()
  if (devices.some((d) => d.kind === "audioinput" && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch {
      /* permission denied: labels stay empty, ids still work */
    }
  }
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
      isMonitor: /monitor of|blackhole|loopback|stereo mix|what u hear/i.test(d.label)
    }))
}

async function getMicrophoneStream(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (err) {
    const name = (err as Error).name
    if (name === "NotAllowedError") throw new Error(permissionHint())
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new Error("The selected microphone was not found. Pick another one in Settings.")
    throw new Error(`Microphone error: ${(err as Error).message}`)
  }
}

async function getSystemStream(): Promise<MediaStream> {
  // Modern path: the main process answers this request with loopback audio (video is our own frame).
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    if (stream.getAudioTracks().length > 0) return stream
    stream.getTracks().forEach((t) => t.stop())
  } catch (err) {
    log("warn", "audio", "getDisplayMedia system audio failed, trying legacy path", (err as Error).message)
  }
  // Legacy Chromium constraint (Windows, and macOS with the older permission model).
  try {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "desktop" } },
      video: { mandatory: { chromeMediaSource: "desktop", maxWidth: 1, maxHeight: 1, maxFrameRate: 1 } }
    } as unknown as MediaStreamConstraints
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    if (stream.getAudioTracks().length > 0) return stream
    stream.getTracks().forEach((t) => t.stop())
  } catch (err) {
    log("warn", "audio", "legacy desktop audio failed", (err as Error).message)
  }
  throw new Error(systemAudioHint())
}

function permissionHint(): string {
  switch (api.platform) {
    case "darwin":
      return "Microphone access was denied. Allow Meetingly in System Settings → Privacy & Security → Microphone."
    case "win32":
      return "Microphone access was denied. Allow it in Windows Settings → Privacy → Microphone."
    default:
      return "Microphone access was denied by the system."
  }
}

function systemAudioHint(): string {
  switch (api.platform) {
    case "darwin":
      return "System audio needs macOS 13 or newer and Screen & System Audio Recording permission for Meetingly (System Settings → Privacy & Security). On older macOS, install BlackHole and pick it as the microphone."
    case "linux":
      return "On Linux, pick the \"Monitor of …\" input device in Settings to capture system audio."
    default:
      return "System audio capture is not available on this machine. It records the Windows default output device."
  }
}
