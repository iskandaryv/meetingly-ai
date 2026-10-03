import { useEffect, useState } from "react"
import { ArrowLeft, Check, CheckCircle2, Clock, Copy, HelpCircle, Lightbulb, RefreshCw, Tag, Target, Trash2 } from "lucide-react"
import type { Meeting } from "@shared/types"
import { api } from "@/lib/api"
import { formatDate, formatDuration } from "@/lib/format"
import { useEvent } from "@/lib/hooks"
import { copyText } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "./MeetingsPage"

interface Props {
  meetingId: string
  onBack: () => void
}

export function MeetingDetails({ meetingId, onBack }: Props) {
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () => void api.invoke("meetings:get", meetingId).then(setMeeting)
  useEffect(load, [meetingId])
  useEvent("meetings:changed", load)

  const copy = async (text: string, key: string) => {
    if (await copyText(text)) {
      setCopied(key)
      setTimeout(() => setCopied(null), 1200)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    try {
      setMeeting(await api.invoke("meetings:regenerate", meetingId))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm("Delete this meeting and its report?")) return
    await api.invoke("meetings:delete", meetingId)
    onBack()
  }

  if (meeting === undefined) return <p className="py-8 text-center text-xs text-white/50">Loading…</p>
  if (meeting === null) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>
        <p className="text-sm text-rose-300">Meeting not found.</p>
      </div>
    )
  }

  const s = meeting.summary
  const shareText = [
    `${meeting.title}`,
    `${formatDate(meeting.startTime)} · ${formatDuration(meeting.duration)}`,
    "",
    s?.overview ?? "",
    ...(s && s.keyPoints.length ? ["", "Key points:", ...s.keyPoints.map((k) => `• ${k}`)] : []),
    ...(s && s.actionItems.length ? ["", "Action items:", ...s.actionItems.map((k) => `• ${k}`)] : []),
    ...(s && s.nextSteps.length ? ["", "Next steps:", ...s.nextSteps.map((k) => `• ${k}`)] : [])
  ].join("\n")

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back"><ArrowLeft className="h-4 w-4" /></Button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-white">{meeting.title}</h2>
            <p className="flex items-center gap-2 text-xs text-white/55">
              {formatDate(meeting.startTime)} <span>·</span> <Clock className="h-3 w-3" /> {formatDuration(meeting.duration)} <StatusBadge status={meeting.status} />
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => copy(shareText, "all")} disabled={!s} title="Copy report">
            {copied === "all" ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />} Copy report
          </Button>
          <Button variant="ghost" size="sm" onClick={regenerate} disabled={busy} title="Regenerate report">
            <RefreshCw className={busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> Regenerate
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-rose-300/80 hover:text-rose-300" onClick={remove} title="Delete meeting">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {s ? (
        <>
          <Section title="Summary" icon={<Lightbulb className="h-4 w-4" />}>
            <p className="selectable text-sm leading-relaxed text-white/85">{s.overview || "No overview produced."}</p>
          </Section>
          <ListSection title="Key points" icon={<Lightbulb className="h-4 w-4" />} items={s.keyPoints} />
          <ListSection title="Decisions" icon={<CheckCircle2 className="h-4 w-4" />} items={s.decisions} />
          <ListSection title="Action items" icon={<CheckCircle2 className="h-4 w-4 text-emerald-300" />} items={s.actionItems} />
          <ListSection title="Next steps" icon={<Target className="h-4 w-4 text-sky-300" />} items={s.nextSteps} />
          <ListSection title="Follow-up questions" icon={<HelpCircle className="h-4 w-4" />} items={s.followUpQuestions} />
          {s.topics.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-white/60">
              <Tag className="h-3.5 w-3.5" />
              {s.topics.map((t) => <span key={t} className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5">{t}</span>)}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-sm text-white/60">
          {meeting.status === "processing" ? "The report is being generated…" : "No report yet. Check your connection, then regenerate."}
        </div>
      )}

      <Section
        title="Transcript"
        icon={<Clock className="h-4 w-4" />}
        action={
          <Button variant="ghost" size="icon-sm" onClick={() => copy(meeting.fullTranscriptText, "t")} title="Copy transcript">
            {copied === "t" ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        }
      >
        <p className="scroll selectable max-h-48 whitespace-pre-wrap text-xs leading-relaxed text-white/70">{meeting.fullTranscriptText}</p>
      </Section>
    </div>
  )
}

function Section({ title, icon, action, children }: { title: string; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/5 p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-white">{icon} {title}</h3>
        {action}
      </header>
      {children}
    </section>
  )
}

function ListSection({ title, icon, items }: { title: string; icon: React.ReactNode; items: string[] }) {
  if (items.length === 0) return null
  return (
    <Section title={title} icon={icon}>
      <ul className="selectable space-y-1.5 text-sm text-white/85">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 leading-relaxed"><span className="text-white/40">•</span><span>{item}</span></li>
        ))}
      </ul>
    </Section>
  )
}
