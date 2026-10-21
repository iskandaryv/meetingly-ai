import fs from "node:fs"
import path from "node:path"
import type { Meeting } from "../../shared/types"
import { t } from "../../shared/i18n"
import { formatTranscript } from "./session"

/**
 * Every session is also written as a plain text file (Documents/Meetingly by default), so the transcript is there
 * to read, search and copy without an account and without any AI: Meetingly works as a transcription tool on its
 * own. The app's own copy (meetings.json) stays the source of truth.
 *
 * `previous` is the file this session already wrote (it is saved every minute while listening): it is rewritten,
 * or renamed when the title changed. Other files are never overwritten.
 */
export function writeTranscriptFile(dir: string, meeting: Meeting, previous: string | null = null): string {
  fs.mkdirSync(dir, { recursive: true })
  const name = transcriptFileName(meeting)
  const file = previous && isNameOrCopy(previous, name) ? previous : uniquePath(dir, name)
  fs.writeFileSync(file, transcriptText(meeting), "utf8")
  // The new file is complete before the old one goes, so a crash in between leaves a copy rather than nothing.
  if (previous && previous !== file) fs.rmSync(previous, { force: true })
  return file
}

/**
 * The running session's file. `save()` runs every minute while listening and writes the transcript so far,
 * `finish()` completes the same file, `discard()` deletes it: a crash or a power cut loses at most a minute.
 */
export class TranscriptAutosave {
  private file: string | null = null
  private lines = 0

  constructor(private readonly dir: string, private readonly draft: () => Meeting | null) {}

  /** Writes the transcript so far, when something was heard since the last write. */
  save(): void {
    const meeting = this.draft()
    if (!meeting || meeting.transcript.length === this.lines) return
    this.file = writeTranscriptFile(this.dir, meeting, this.file)
    this.lines = meeting.transcript.length
  }

  /** The finished session's file, named after its final title. */
  finish(meeting: Meeting): string {
    try {
      return writeTranscriptFile(this.dir, meeting, this.file)
    } finally {
      this.forget()
    }
  }

  discard(): void {
    if (this.file) fs.rmSync(this.file, { force: true })
    this.forget()
  }

  private forget(): void {
    this.file = null
    this.lines = 0
  }
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

/** "Name.txt" itself or a numbered copy of it ("Name (2).txt"). */
function isNameOrCopy(file: string, name: string): boolean {
  const own = path.basename(file)
  const ext = path.extname(name)
  const base = name.slice(0, -ext.length)
  if (own === name) return true
  if (!own.startsWith(`${base} (`) || !own.endsWith(`)${ext}`)) return false
  return /^\d+$/.test(own.slice(base.length + 2, own.length - ext.length - 1))
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = name.slice(0, -ext.length)
  let candidate = path.join(dir, name)
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}
