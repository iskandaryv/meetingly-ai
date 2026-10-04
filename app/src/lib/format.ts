import { getLocale, t } from "@shared/i18n"

/** 1:05, 12:30, 1:02:03 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`
  return t("{s}s", { s })
}

/** "14:05" today, "Tue, Sep 16" this week, "Sep 2" otherwise. */
export function formatWhen(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const ageHours = (now - timestamp) / 3_600_000
  if (ageHours < 24 && date.getDate() === new Date(now).getDate()) {
    return date.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" })
  }
  if (ageHours < 24 * 7) return date.toLocaleDateString(getLocale(), { weekday: "short", month: "short", day: "numeric" })
  return date.toLocaleDateString(getLocale(), { month: "short", day: "numeric" })
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(getLocale(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
}

export function truncate(text: string, max: number): string {
  const clean = text.trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}
