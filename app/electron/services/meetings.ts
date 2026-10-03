import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"
import type { Meeting } from "../../shared/types"

/**
 * Meetings persisted as one JSON array, newest first.
 * Events: "changed"
 */
export class MeetingStore extends EventEmitter {
  private cache: Meeting[] | null = null

  constructor(private readonly file: string) {
    super()
  }

  list(): Meeting[] {
    return this.all().map((m) => ({ ...m }))
  }

  get(id: string): Meeting | null {
    const found = this.all().find((m) => m.id === id)
    return found ? { ...found } : null
  }

  /** `quiet` writes without bumping updatedAt or emitting "changed" (used by sync to avoid echo loops). */
  save(meeting: Meeting, quiet = false): void {
    const all = this.all()
    const index = all.findIndex((m) => m.id === meeting.id)
    const stamped = quiet ? { ...meeting } : { ...meeting, updatedAt: Date.now() }
    if (index >= 0) all[index] = stamped
    else all.unshift(stamped)
    all.sort((a, b) => b.startTime - a.startTime)
    this.persist(all, quiet)
  }

  delete(id: string): boolean {
    const all = this.all()
    const next = all.filter((m) => m.id !== id)
    if (next.length === all.length) return false
    this.persist(next)
    return true
  }

  private all(): Meeting[] {
    if (this.cache) return this.cache
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"))
        this.cache = Array.isArray(parsed) ? parsed : []
      } else {
        this.cache = []
      }
    } catch (err) {
      console.error("[meetings] failed to read store:", err)
      this.cache = []
    }
    return this.cache
  }

  private persist(all: Meeting[], quiet = false): void {
    this.cache = all
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error("[meetings] failed to write store:", err)
    }
    // Windows still need to refresh their lists; only sync ignores quiet writes.
    this.emit(quiet ? "changed-quiet" : "changed")
  }
}
