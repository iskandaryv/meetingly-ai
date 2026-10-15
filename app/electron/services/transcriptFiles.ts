import fs from "node:fs"
import path from "node:path"
import type { Meeting } from "../../shared/types"
import { t } from "../../shared/i18n"
import { formatTranscript } from "./session"

/**
 * Every finished session is also written as a plain text file (Documents/Meetingly by default), so the
 * transcript is there to read, search and copy without an account and without any AI: Meetingly works as a
 * transcription tool on its own. The app's own copy (meetings.json) stays the source of truth.
 */
export function writeTranscriptFile(dir: string, meeting: Meeting): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = uniquePath(dir, transcriptFileName(meeting))
  fs.writeFileSync(file, transcriptText(meeting), "utf8")
  return file
}

/** "2026-10-15 14-05 Weekly sync.txt" (local time; characters no file system accepts are removed). */
export function transcriptFileName(meeting: Pick<Meeting, "startTime" | "title">): string {
  const d = new Date(meeting.startTime)
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`
  const title = meeting.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 60)
  return `${stamp}${title ? ` ${title}` : ""}.txt`
}

/** Title, date and length, then the transcript with You / Them on each turn. Windows line endings open everywhere. */
export function transcriptText(meeting: Meeting): string {
  const minutes = Math.max(1, Math.round(meeting.duration / 60_000))
  const when = new Date(meeting.startTime).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })
  const body = meeting.transcript.length ? formatTranscript(meeting.transcript) : meeting.fullTranscriptText
  return [meeting.title, `${when} · ${t("{minutes} min", { minutes })}`, "", body, ""].join("\r\n").replace(/(?<!\r)\n/g, "\r\n")
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = name.slice(0, -ext.length)
  let candidate = path.join(dir, name)
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}
