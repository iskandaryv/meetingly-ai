import { useEffect, useRef, useState } from "react"
import type { Channel, SessionState } from "@shared/types"
import { api, log } from "@/lib/api"
import { startAudioCapture, type AudioCapture, type AudioLevels } from "@/lib/audio"
import { useEvent } from "@/lib/hooks"

const NO_LEVELS: AudioLevels = { microphone: null, system: null }

export interface TranscriptLine {
  text: string
  speaker: number | null
  /** "you" (microphone) / "them" (system audio) when transcribed per channel. */
  channel: Channel | null
}

/** Words still being recognized, per side; both people can be mid-sentence at once. */
export type Interim = Partial<Record<Channel | "other", string>>

/**
 * Captures the microphone / system audio while the session is recording and streams it to
 * the main process. Lives in the panel window, which exists (shown or hidden) for the whole
 * session, so hiding the panel never stops the recording. Changing the source while recording
 * restarts the capture with the new one.
 */
export function useAudioCapture(session: SessionState): { levels: AudioLevels; error: string | null; warnings: string[] } {
  const [levels, setLevels] = useState<AudioLevels>(NO_LEVELS)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const captureRef = useRef<AudioCapture | null>(null)

  useEffect(() => {
    if (captureRef.current) {
      captureRef.current.stop()
      captureRef.current = null
      setLevels(NO_LEVELS)
    }
    if (session.status !== "recording") {
      if (session.status === "idle") setWarnings([])
      return undefined
    }
    let cancelled = false
    startAudioCapture(
      session.audioSource,
      session.audioDeviceId,
      (chunk) => void api.invoke("session:audio", chunk).catch(() => {}),
      (l) => setLevels(l)
    )
      .then((capture) => {
        if (cancelled) capture.stop()
        else {
          captureRef.current = capture
          setError(null)
          setWarnings(capture.warnings)
        }
      })
      .catch((err: Error) => {
        log("error", "audio", "capture failed", { source: session.audioSource, message: err.message })
        setError(err.message)
        void api.invoke("session:pause")
      })
    return () => {
      cancelled = true
    }
  }, [session.status, session.audioSource, session.audioDeviceId])

  useEffect(() => () => captureRef.current?.stop(), [])
  return { levels, error, warnings }
}

/** The live transcript: one line per finished utterance plus in-progress words per side. */
export function useLiveTranscript(session: SessionState): { lines: TranscriptLine[]; interim: Interim } {
  const [lines, setLines] = useState<TranscriptLine[]>([])
  const [interim, setInterim] = useState<Interim>({})

  useEffect(() => {
    void api.invoke("session:transcript").then((t) => setLines(t ? [{ text: t, speaker: null, channel: null }] : []))
  }, [])
  useEvent("session:transcript", (e) => {
    const side = e.channel ?? "other"
    if (e.isFinal) {
      // One line per finished utterance; the view groups consecutive lines from the same side.
      setLines((prev) => [...prev, { text: e.text, speaker: e.speaker, channel: e.channel ?? null }])
      setInterim((cur) => ({ ...cur, [side]: "" }))
    } else {
      setInterim((cur) => ({ ...cur, [side]: e.text }))
    }
  })
  useEffect(() => {
    if (session.status === "idle") {
      setLines([])
      setInterim({})
    }
  }, [session.status])
  return { lines, interim }
}
