import { useEffect, useRef, useState } from "react"
import { Camera, Check, CircleHelp, Copy, Eraser, ListChecks, MessageSquareQuote, MessageSquareReply, Mic, PanelLeft, RefreshCw, SendHorizontal, Volume2, X } from "lucide-react"
import {
  AUDIO_SOURCE_LABELS,
  QUICK_ACTIONS,
  segmentLabel,
  suggestionsVisible,
  type AudioSource,
  type ChatChunk,
  type ChatMessage,
  type PanelTab,
  type PlanState,
  type QuickActionId,
  type SuggestionsState
} from "@shared/types"
import { t } from "@shared/i18n"
import { api, shortcutLabel } from "@/lib/api"
import { useAudioCapture, useLiveTranscript, type Interim, type TranscriptLine } from "@/lib/capture"
import { useCloudState, useEvent, usePlanState, useSessionState, useSettings, useSuggestions } from "@/lib/hooks"
import { listAudioInputs, type AudioInputDevice, type AudioLevels } from "@/lib/audio"
import { cn, copyText } from "@/lib/utils"
import { markdownToPlain } from "@/lib/plain-text"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/fields"
import { Markdown } from "@/components/Markdown"

/**
 * The panel attached under the toolbar: answers and the live transcript as two tabs, with
 * suggested questions on the left while listening. It also owns audio capture, which keeps
 * running on either tab and while hidden.
 */
export function PanelWindow() {
  const session = useSessionState()
  const [settings, update] = useSettings()
  const [tab, setTab] = useState<PanelTab>("answers")
  const capture = useAudioCapture(session)
  const transcript = useLiveTranscript(session)
  const suggestions = useSuggestions()
  const plan = usePlanState()

  useEffect(() => {
    void api.invoke("windows:state").then((s) => setTab(s.panelTab))
  }, [])
  useEvent("panel:tab", setTab)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.invoke("windows:hide", "chat")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const choose = (next: PanelTab) => {
    setTab(next)
    void api.invoke("panel:set-tab", next)
  }
  const handsFree = settings ? settings.autoAnswer !== "off" : true
  const rail = suggestionsVisible(settings, session.status)

  return (
    <div className="flex h-screen w-full flex-col p-1">
      <div className="glass flex h-full w-full flex-col overflow-hidden">
        <header className="drag flex h-9 shrink-0 items-center gap-1 border-b border-white/10 pl-1 pr-1">
          <div className="no-drag flex items-center rounded-md bg-white/[0.04] p-0.5">
            <TabButton active={tab === "answers"} onClick={() => choose("answers")}>{t("Answers")}</TabButton>
            <TabButton active={tab === "transcript"} onClick={() => choose("transcript")}>
              {t("Transcript")}
              {session.status === "recording" && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />}
            </TabButton>
          </div>
          <div className="no-drag ml-auto flex items-center gap-0.5">
            {session.status !== "idle" && settings && (
              <Button
                variant={rail ? "secondary" : "ghost"}
                size="icon-sm"
                className="h-7 w-7"
                onClick={() => void update({ suggestions: !settings.suggestions })}
                title={rail ? t("Hide suggested questions") : t("Show suggested questions")}
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </Button>
            )}
            {tab === "answers" ? (
              <button
                type="button"
                onClick={() => update({ autoAnswer: handsFree ? "off" : "questions" })}
                title={handsFree ? t("Questions heard in the meeting are answered automatically. Click to turn off.") : t("Click to answer questions from the meeting automatically.")}
                className={cn(
                  "h-6 rounded-full px-2 text-[11px] font-medium transition-colors",
                  handsFree ? "bg-sky-500/80 text-white hover:bg-sky-400/80" : "text-white/55 hover:bg-white/10 hover:text-white"
                )}
              >
                {handsFree ? t("Auto-answer on") : t("Auto-answer off")}
              </button>
            ) : (
              <Levels levels={capture.levels} />
            )}
            <Button variant="ghost" size="icon-sm" className="h-7 w-7" onClick={() => api.invoke("windows:hide", "chat")} title={t("Close (Esc)")}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </header>
        {settings && settings.shortcutConflicts.length > 0 && (
          <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">
            <span className="min-w-0 flex-1 truncate">
              {t("Another app already uses {keys}. Pick other keys on the web dashboard.", { keys: settings.shortcutConflicts.map((a) => shortcutLabel(settings.shortcuts[a])).join(", ") })}
            </span>
            <button type="button" className="no-drag shrink-0 font-medium text-amber-100 hover:text-white" onClick={() => void api.invoke("cloud:open-web")}>
              {t("Open")}
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {rail && <Suggestions state={suggestions} plan={plan} />}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Both tabs stay mounted: a reply keeps streaming and scroll positions survive tab switches. */}
            <div className={cn("min-h-0 flex-1 flex-col", tab === "answers" ? "flex" : "hidden")}>
              <Answers listening={session.status !== "idle"} handsFree={handsFree} plan={plan} />
            </div>
            <div className={cn("min-h-0 flex-1 flex-col", tab === "transcript" ? "flex" : "hidden")}>
              <Transcript
                status={session.status}
                connected={session.connected}
                source={session.audioSource}
                notice={capture.error ?? session.notice ?? capture.warnings[0] ?? null}
                lines={transcript.lines}
                interim={transcript.interim}
                onSource={(s) => void update({ audioSource: s })}
                deviceId={settings?.audioDeviceId ?? ""}
                onDevice={(id) => void update({ audioDeviceId: id })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 items-center rounded px-2.5 text-[12px] font-medium transition-colors",
        active ? "bg-white/[0.12] text-white shadow-sm" : "text-white/50 hover:text-white/80"
      )}
    >
      {children}
    </button>
  )
}

const ACTION_ICONS: Record<QuickActionId, React.ReactNode> = {
  say: <MessageSquareQuote className="h-3 w-3" />,
  ask: <CircleHelp className="h-3 w-3" />,
  recap: <ListChecks className="h-3 w-3" />
}

/** Questions drawn from the conversation, then fixed quick actions; a click answers in the Answers tab. */
function Suggestions({ state, plan }: { state: SuggestionsState; plan: PlanState }) {
  const [busy, setBusy] = useState(false)
  useEvent("chat:busy", setBusy)
  const use = (id: string) => void api.invoke("suggestions:use", id).catch(() => {})

  return (
    <aside className="flex w-[200px] shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
      <div className="flex h-7 shrink-0 items-center gap-1 pl-2.5 pr-1">
        <span className="flex-1 text-[10.5px] font-medium uppercase tracking-wide text-white/35">{t("Suggested")}</span>
        <button
          type="button"
          onClick={() => void api.invoke("suggestions:refresh").catch(() => {})}
          disabled={state.updating}
          title={t("Refresh from the conversation")}
          className="rounded p-1 text-white/35 transition-colors hover:bg-white/10 hover:text-white/80 disabled:hover:bg-transparent"
        >
          <RefreshCw className={cn("h-3 w-3", state.updating && "animate-spin")} />
        </button>
      </div>
      {state.topic && (
        <p className="truncate px-2.5 pb-1 text-[11px] text-sky-200/55" title={state.topic}>
          {state.topic}
        </p>
      )}
      <div className="scroll min-h-0 flex-1 space-y-0.5 px-1 pb-1">
        {state.items.length === 0 ? (
          <p className="px-1.5 py-1 text-[11px] leading-snug text-white/35">
            {plan.used && plan.limits && plan.used.listening >= plan.limits.listening
              ? plan.plan === "pro"
                ? t("Paused for today: the daily limit is used.")
                : t("Paused for today: upgrade to Pro for more.")
              : state.updating
                ? t("Reading the conversation…")
                : t("Questions show up here as the conversation goes.")}
          </p>
        ) : (
          state.items.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => use(s.id)}
              title={s.text}
              className="line-clamp-3 w-full animate-fade-in rounded-md px-1.5 py-1 text-left text-[12px] leading-snug text-white/85 transition-colors hover:bg-white/[0.07] hover:text-white disabled:opacity-45"
            >
              {s.text}
            </button>
          ))
        )}
      </div>
      <div className="space-y-px border-t border-white/10 p-1">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={busy}
            onClick={() => use(a.id)}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white disabled:opacity-45"
          >
            <span className="text-white/40">{ACTION_ICONS[a.id]}</span>
            {t(a.label)}
          </button>
        ))}
      </div>
    </aside>
  )
}

function Answers({ listening, handsFree, plan }: { listening: boolean; handsFree: boolean; plan: PlanState }) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [stream, setStream] = useState<ChatChunk | null>(null)
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState("")
  const [heard, setHeard] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api.invoke("chat:history").then(setHistory)
    void api.invoke("session:last-utterance").then((u) => setHeard(u?.text ?? null))
    inputRef.current?.focus()
  }, [])
  useEvent("chat:message", (m) => {
    setHistory((h) => [...h, m])
    setStream(null)
  })
  useEvent("chat:chunk", (c) => setStream((s) => (s && s.id === c.id ? { id: c.id, text: s.text + c.text } : c)))
  useEvent("chat:busy", setBusy)
  useEvent("chat:cleared", () => {
    setHistory([])
    setStream(null)
  })
  useEvent("session:utterance", (u) => setHeard(u.text))
  useEvent("session:state", (s) => {
    if (s.status === "idle") setHeard(null)
  })
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [history.length, stream?.text.length])

  const send = (text: string) => {
    if (!text.trim() || busy) return
    setInput("")
    void api.invoke("chat:send", text)
    inputRef.current?.focus()
  }

  return (
    <>
      <div ref={listRef} className="scroll min-h-0 flex-1 space-y-1.5 px-2.5 py-2">
        {history.length === 0 && !stream && (
          <p className="px-4 py-6 text-center text-[11.5px] leading-relaxed text-white/45">
            {handsFree ? t("Ask anything, or press Listen: questions from the meeting are answered here.") : t("Ask anything. Auto-answer is off.")}
          </p>
        )}
        {history.map((m) => <Message key={m.id} message={m} />)}
        {stream && (
          <div className={ANSWER}>
            <Markdown text={stream.text} />
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-white/70 align-middle" />
          </div>
        )}
        {busy && !stream && <p className="animate-pulse px-1 text-[11px] text-white/45">{t("Thinking…")}</p>}
      </div>

      {listening && heard && (
        <div className="flex items-center gap-1.5 border-t border-white/10 px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[11px] text-white/50" title={heard}>
            <span className="mr-1 text-white/35">{t("Heard")}</span>
            {heard}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => void api.invoke("chat:answer-last")} title={t("Answer the last thing heard")}>
            <MessageSquareReply className="h-3 w-3" /> {t("Answer")}
          </Button>
        </div>
      )}

      <PlanBar plan={plan} />

      <form
        className="flex items-center gap-1 border-t border-white/10 p-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <Button type="button" variant="ghost" size="icon-sm" title={t("Analyze my screen")} disabled={busy} onClick={() => void api.invoke("chat:screenshot").catch(() => {})}>
          <Camera className="h-3.5 w-3.5" />
        </Button>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder={busy ? t("Waiting for reply…") : t("Type a message")}
          className="h-7 min-w-0 flex-1 rounded-md border border-white/[0.12] bg-white/5 px-2.5 text-[13px] text-white placeholder:text-white/35 focus:border-white/35 focus:outline-none"
        />
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => api.invoke("chat:clear")} title={t("Clear conversation")} disabled={history.length === 0}>
          <Eraser className="h-3.5 w-3.5" />
        </Button>
        <Button type="submit" variant="primary" size="icon-sm" title={t("Send (Enter)")} disabled={busy || !input.trim()}>
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
      </form>
    </>
  )
}

/** Without an account: the sign-up prompt. On the free plan: today's answers left. Nothing on Pro. */
/**
 * The account line under the answers. Signed out: sign up or sign in happens in the browser, which links
 * this computer (the code shown here must match the one on the page). Signed in on Free: answers left today.
 */
function PlanBar({ plan }: { plan: PlanState }) {
  const cloud = useCloudState()
  if (cloud.status === "linking" && cloud.code) {
    return (
      <div className="flex items-center gap-2 border-t border-white/10 bg-sky-500/10 px-2.5 py-1.5 text-[11.5px] text-sky-100">
        <span className="min-w-0 flex-1 leading-snug">
          {t("Confirm this code in your browser:")} <span className="selectable font-mono font-semibold tracking-[0.2em] text-white">{cloud.code}</span>
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void api.invoke("cloud:link-start").catch(() => {})}>
          {t("Open the page again")}
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void api.invoke("cloud:link-cancel")}>
          {t("Cancel")}
        </Button>
      </div>
    )
  }
  if (plan.status === "signed-out") {
    return (
      <div className="border-t border-white/10 bg-sky-500/10 px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-sky-100">{t("Create a free account to get AI answers: 100 a day, no card.")}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-sky-100" onClick={() => void api.invoke("cloud:link-start").catch(() => {})}>
            {t("Sign in")}
          </Button>
          <Button variant="primary" size="sm" className="h-6 px-2.5 text-[11px]" onClick={() => void api.invoke("cloud:link-start").catch(() => {})}>
            {t("Sign up free")}
          </Button>
        </div>
        {cloud.error && <p className="mt-1 text-[11px] text-amber-200">{cloud.error}</p>}
      </div>
    )
  }
  if (plan.status !== "ok" || plan.plan === "pro" || !plan.used || !plan.limits) return null
  const left = Math.max(0, plan.limits.answers - plan.used.answers)
  return (
    <div className="flex items-center gap-1.5 border-t border-white/10 px-2.5 py-1 text-[11px] text-white/45">
      <span className={cn("min-w-0 flex-1 truncate", left === 0 && "text-amber-200")}>
        {left === 0 ? t("No answers left today. They come back at midnight UTC.") : t("{left} of {total} answers left today", { left, total: plan.limits.answers })}
      </span>
      <button type="button" className="font-medium text-sky-300 hover:text-sky-200" onClick={() => void api.invoke("plan:upgrade").catch(() => {})}>
        {t("Upgrade")}
      </button>
    </div>
  )
}

/** Answer bubbles: deep navy so they stand apart from everything else; what was heard is a quiet line above. */
const ANSWER = "rounded-lg bg-[#132238] px-3 py-2 ring-1 ring-inset ring-sky-300/10"

function Message({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false)
  if (message.role === "user") {
    if (message.kind === "auto") {
      return (
        <p className="selectable px-1 pt-1 text-[11.5px] leading-snug text-white/55">
          <span className="mr-1.5 text-[10.5px] font-medium text-white/35">{t("Heard")}</span>
          {message.text}
        </p>
      )
    }
    return <p className="selectable ml-10 rounded-lg bg-white/[0.08] px-3 py-1.5 text-[12.5px] text-white/90">{message.text}</p>
  }
  const copy = async () => {
    if (await copyText(markdownToPlain(message.text))) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }
  return (
    <div className={cn("group relative", message.kind === "error" ? "rounded-lg bg-rose-500/15 px-3 py-2 text-rose-200" : ANSWER)}>
      {message.kind === "screenshot" && <div className="mb-0.5 flex items-center gap-1 text-[10.5px] text-sky-200/50"><Camera className="h-3 w-3" /> {t("Screen")}</div>}
      {message.kind === "error" ? <p className="selectable text-[12.5px]">{message.text}</p> : <Markdown text={message.text} />}
      {message.kind !== "error" && (
        <button
          type="button"
          onClick={copy}
          title={t("Copy")}
          className="absolute right-1 top-1 rounded p-1 text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  )
}

interface Turn {
  side: "you" | "them" | "other"
  label: string
  texts: string[]
}

/** Speaker labels stay English as data (the model and saved meetings read them); translate them on screen. */
function speakerText(label: string): string {
  const numbered = label.match(/^Speaker (\d+)$/)
  return numbered ? t("Speaker {n}", { n: numbered[1] }) : t(label)
}

/** Consecutive lines from the same side become one turn, like a chat. */
function toTurns(lines: TranscriptLine[]): Turn[] {
  const turns: Turn[] = []
  for (const l of lines) {
    const side = l.channel ?? "other"
    const label = segmentLabel(l) || ""
    const last = turns[turns.length - 1]
    if (last && last.side === side && last.label === label) last.texts.push(l.text)
    else turns.push({ side, label, texts: [l.text] })
  }
  return turns
}

function Transcript(props: {
  status: string
  connected: boolean
  source: AudioSource
  notice: string | null
  lines: TranscriptLine[]
  interim: Interim
  onSource: (s: AudioSource) => void
  deviceId: string
  onDevice: (id: string) => void
}) {
  const { status, connected, source, notice, lines, interim, onSource, deviceId, onDevice } = props
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const live = [interim.them, interim.you, interim.other].filter(Boolean).join(" ")
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines.length, live])

  const turns = toTurns(lines)
  const text = turns.map((turn) => (turn.label ? `${speakerText(turn.label)}: ${turn.texts.join(" ")}` : turn.texts.join(" "))).join("\n")
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }

  return (
    <>
      {notice && <div className="mx-2 mt-1.5 rounded-md border border-amber-400/25 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">{notice}</div>}
      {status === "idle" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-[11.5px] text-white/50">{t("The live transcript shows here while listening.")}</p>
          <Button variant="primary" size="sm" onClick={() => void api.invoke("session:start").catch(() => {})}>
            <Mic className="h-3.5 w-3.5" /> {t("Start listening")}
          </Button>
        </div>
      ) : (
        <div ref={ref} className="scroll selectable min-h-0 flex-1 space-y-2 px-2.5 py-2 text-[12.5px] leading-relaxed">
          {turns.map((turn, i) => <TurnView key={i} turn={turn} />)}
          {(["them", "other", "you"] as const).map((side) => {
            const words = interim[side]
            return words ? <TurnView key={`live-${side}`} turn={{ side, label: "", texts: [words] }} live /> : null
          })}
          {!text && !live && <p className="text-white/40">{connected ? t("Listening…") : t("Starting…")}</p>}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-white/10 p-1.5">
        <Select value={source} onChange={(e) => onSource(e.target.value as AudioSource)} className="h-7 min-w-0 flex-1 bg-black/30 px-2 py-0 text-[11px]" title={t("What to transcribe")}>
          {(Object.keys(AUDIO_SOURCE_LABELS) as AudioSource[]).map((s) => <option key={s} value={s}>{t(AUDIO_SOURCE_LABELS[s])}</option>)}
        </Select>
        {source !== "system" && <MicPicker value={deviceId} onChange={onDevice} />}
        <Button variant="ghost" size="icon-sm" onClick={copy} disabled={!text} title={t("Copy transcript")}>
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </>
  )
}

/** The microphone to listen with; the list is read again whenever it is opened, so new devices show up. */
function MicPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [devices, setDevices] = useState<AudioInputDevice[]>([])
  const refresh = () => void listAudioInputs().then(setDevices).catch(() => setDevices([]))
  useEffect(refresh, [])
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} onFocus={refresh} className="h-7 min-w-0 flex-1 bg-black/30 px-2 py-0 text-[11px]" title={t("Microphone")}>
      <option value="">{t("Default microphone")}</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.isMonitor ? t("{label} (system audio)", { label: d.label }) : d.label}
        </option>
      ))}
      {value && !devices.some((d) => d.id === value) && <option value={value}>{t("Previously selected device (unplugged)")}</option>}
    </Select>
  )
}

/** The other side on the left, you on the right; unlabelled (cloud) speakers on the left with their label. */
function TurnView({ turn, live }: { turn: Turn; live?: boolean }) {
  const mine = turn.side === "you"
  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      {turn.label && <span className="mb-0.5 px-1 text-[10.5px] font-medium text-white/40">{speakerText(turn.label)}</span>}
      <div
        className={cn(
          "max-w-[88%] space-y-1 rounded-lg px-2.5 py-1.5",
          mine ? "rounded-br-sm bg-sky-500/15 text-sky-50/90" : "rounded-bl-sm bg-white/[0.06] text-white/90",
          live && "italic opacity-70"
        )}
      >
        {turn.texts.map((line, i) => <p key={i}>{line}</p>)}
      </div>
    </div>
  )
}

/** Microphone and system-audio meters; dimmed when that source is not captured. */
function Levels({ levels }: { levels: AudioLevels }) {
  return (
    <div className="mr-1 flex items-center gap-2">
      <Meter icon={<Mic className="h-3 w-3" />} level={levels.microphone} title={t("Microphone")} />
      <Meter icon={<Volume2 className="h-3 w-3" />} level={levels.system} title={t("System audio")} />
    </div>
  )
}

function Meter({ icon, level, title }: { icon: React.ReactNode; level: number | null; title: string }) {
  const active = level !== null
  const pct = Math.round((level ?? 0) * 100)
  return (
    <div className={cn("flex items-center gap-1", active ? "text-white/70" : "text-white/25")} title={active ? `${title}: ${pct}%` : t("{title}: not captured", { title })}>
      {icon}
      <div className="h-1 w-9 overflow-hidden rounded-full bg-white/10">
        <div className={cn("h-full rounded-full transition-[width] duration-100", pct > 70 ? "bg-rose-400" : "bg-emerald-400")} style={{ width: `${active ? Math.max(pct, 2) : 0}%` }} />
      </div>
    </div>
  )
}
