import fs from "node:fs"
import path from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_BYTES = 5 * 1024 * 1024
const KEEP_ROTATIONS = 3

/**
 * Line-oriented log file, so a failed session can be diagnosed after the fact.
 * Writes are synchronous and appended: a crash keeps everything up to it.
 * Secrets are redacted before anything is written.
 */
export class Logger {
  private stream: fs.WriteStream | null = null
  private bytes = 0
  private readonly minLevel: number

  constructor(
    readonly file: string,
    level: LogLevel = "info",
    private readonly mirrorToConsole = true
  ) {
    this.minLevel = LEVELS[level]
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      this.rotateIfNeeded()
      this.stream = fs.createWriteStream(file, { flags: "a" })
    } catch (err) {
      console.error("[logger] cannot open log file:", err)
    }
  }

  debug(scope: string, message: string, data?: unknown): void {
    this.write("debug", scope, message, data)
  }
  info(scope: string, message: string, data?: unknown): void {
    this.write("info", scope, message, data)
  }
  warn(scope: string, message: string, data?: unknown): void {
    this.write("warn", scope, message, data)
  }
  error(scope: string, message: string, data?: unknown): void {
    this.write("error", scope, message, data)
  }

  private write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (LEVELS[level] < this.minLevel) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${data === undefined ? "" : ` ${format(data)}`}\n`
    const safe = redact(line)
    if (this.mirrorToConsole) process.stdout.write(safe)
    try {
      this.stream?.write(safe)
      this.bytes += safe.length
      if (this.bytes > MAX_BYTES) this.reopen()
    } catch {
      /* never let logging break the app */
    }
  }

  private reopen(): void {
    this.stream?.end()
    this.stream = null
    this.bytes = 0
    this.rotateIfNeeded(true)
    try {
      this.stream = fs.createWriteStream(this.file, { flags: "a" })
    } catch {
      /* keep running without a log file */
    }
  }

  private rotateIfNeeded(force = false): void {
    try {
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
      if (!force && size < MAX_BYTES) {
        this.bytes = size
        return
      }
      for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`)
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`)
      this.bytes = 0
    } catch {
      /* rotation is best effort */
    }
  }
}

function format(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}`
  if (typeof data === "string") return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

/** Keys and tokens must never reach the log file. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1…")
    .replace(/\b(igpt_v1_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, "$1…")
    .replace(/\b(Bearer\s+[A-Za-z0-9_-]{6})[A-Za-z0-9_.-]+/gi, "$1…")
    .replace(/\b(Token\s+[A-Za-z0-9]{6})[A-Za-z0-9]+/gi, "$1…")
}
