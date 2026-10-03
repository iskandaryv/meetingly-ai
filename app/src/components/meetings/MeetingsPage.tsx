import { useEffect, useState } from "react"
import { Activity, Clock, RefreshCw, Search } from "lucide-react"
import type { Meeting } from "@shared/types"
import { api } from "@/lib/api"
import { formatDuration, formatWhen, truncate } from "@/lib/format"
import { useEvent } from "@/lib/hooks"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/fields"
import { MeetingDetails } from "./MeetingDetails"

export function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  const load = () => void api.invoke("meetings:list").then(setMeetings)
  useEffect(load, [])
  useEvent("meetings:changed", load)

  if (selected) return <MeetingDetails meetingId={selected} onBack={() => setSelected(null)} />

  const q = query.trim().toLowerCase()
  const visible = (meetings ?? []).filter(
    (m) => !q || m.title.toLowerCase().includes(q) || m.fullTranscriptText.toLowerCase().includes(q) || m.summary?.overview.toLowerCase().includes(q)
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-white/60" /> Meeting history
          {meetings && meetings.length > 0 && <Badge>{meetings.length}</Badge>}
        </h2>
        <Button variant="ghost" size="icon-sm" onClick={load} title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {meetings && meetings.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
          <Input type="search" placeholder="Search title, summary or transcript" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
      )}

      {meetings === null ? (
        <p className="py-8 text-center text-xs text-white/50">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="py-10 text-center">
          <Activity className="mx-auto mb-2 h-8 w-8 text-white/25" />
          <p className="text-sm text-white/60">{meetings.length === 0 ? "No meetings yet" : "Nothing matches your search"}</p>
          {meetings.length === 0 && <p className="mt-1 text-xs text-white/45">Press Listen on the toolbar, then Finish to save a meeting with an AI report.</p>}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setSelected(m.id)}
                className="w-full rounded-lg border border-white/10 bg-white/5 p-3 text-left transition-colors hover:border-white/25 hover:bg-white/10"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-white">{m.title}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={m.status} />
                    <span className="text-[11px] text-white/50">{formatWhen(m.startTime)}</span>
                  </div>
                </div>
                <p className="mb-2 text-xs leading-relaxed text-white/65">{truncate(m.summary?.overview || m.fullTranscriptText || "No content", 140)}</p>
                <div className="flex items-center gap-3 text-[11px] text-white/50">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatDuration(m.duration)}</span>
                  {m.summary && m.summary.actionItems.length > 0 && <span>{m.summary.actionItems.length} action items</span>}
                  {m.summary && m.summary.keyPoints.length > 0 && <span>{m.summary.keyPoints.length} key points</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function StatusBadge({ status }: { status: Meeting["status"] }) {
  if (status === "completed") return <Badge variant="success">Report ready</Badge>
  if (status === "processing") return <Badge variant="info">Generating…</Badge>
  return <Badge variant="danger">Report failed</Badge>
}
