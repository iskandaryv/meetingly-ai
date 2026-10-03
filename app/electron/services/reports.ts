import { getLanguage, type LanguageCode, type Meeting, type MeetingSummary } from "../../shared/types"
import type { Llm } from "./llm"
import type { MeetingStore } from "./meetings"
import type { SettingsStore } from "./settings"

interface Deps {
  llm: Llm
  meetings: MeetingStore
  settings: SettingsStore
}

const SECTIONS = {
  title: "TITLE",
  overview: "OVERVIEW",
  keyPoints: "KEY POINTS",
  decisions: "DECISIONS",
  actionItems: "ACTION ITEMS",
  nextSteps: "NEXT STEPS",
  followUpQuestions: "FOLLOW-UP QUESTIONS",
  topics: "TOPICS"
} as const

/** Turns a finished meeting transcript into a structured summary. */
export class ReportGenerator {
  constructor(private readonly deps: Deps) {}

  /**
   * Meetings stuck on "processing" from a previous run (crash, quit mid-report)
   * would never finish on their own. Retry them once at startup.
   */
  async resumeUnfinished(): Promise<void> {
    const stuck = this.deps.meetings.list().filter((m) => m.status === "processing")
    if (stuck.length === 0) return
    console.log(`[reports] resuming ${stuck.length} unfinished report(s)`)
    for (const meeting of stuck) {
      try {
        await this.generate(meeting.id)
      } catch (err) {
        console.error("[reports] resume failed:", err)
      }
    }
  }

  async generate(meetingId: string): Promise<Meeting | null> {
    const meeting = this.deps.meetings.get(meetingId)
    if (!meeting) return null
    if (!meeting.fullTranscriptText.trim()) {
      this.deps.meetings.save({ ...meeting, status: "failed" })
      return this.deps.meetings.get(meetingId)
    }
    this.deps.meetings.save({ ...meeting, status: "processing", summary: undefined })
    const language = this.deps.settings.get().outputLanguage
    try {
      const { text } = await this.deps.llm.chat([
        { role: "system", content: `You are an expert meeting analyst. ${getLanguage(language).instruction}` },
        { role: "user", content: buildReportPrompt(meeting) }
      ], undefined, "report")
      const summary = parseReport(text, language)
      this.deps.meetings.save({
        ...meeting,
        title: summary.title || meeting.title,
        status: "completed",
        summary
      })
    } catch (err) {
      console.error("[reports] generation failed:", err)
      this.deps.meetings.save({ ...meeting, status: "failed" })
    }
    return this.deps.meetings.get(meetingId)
  }
}

export function buildReportPrompt(meeting: Meeting): string {
  const minutes = Math.max(1, Math.round(meeting.duration / 60000))
  return `Analyze this meeting transcript (${minutes} min, ${new Date(meeting.startTime).toLocaleString()}).

TRANSCRIPT:
"""
${meeting.fullTranscriptText}
"""

Reply using exactly these section headers, each on its own line, in this order. Use "- " bullets inside list sections. Leave a section empty if nothing applies.

**${SECTIONS.title}:**
(one line, a descriptive title)

**${SECTIONS.overview}:**
(2-3 sentences)

**${SECTIONS.keyPoints}:**
**${SECTIONS.decisions}:**
**${SECTIONS.actionItems}:**
**${SECTIONS.nextSteps}:**
**${SECTIONS.followUpQuestions}:**
**${SECTIONS.topics}:**`
}

/** Parse the sectioned reply. Tolerates missing sections and stray markdown. */
export function parseReport(text: string, language: LanguageCode): MeetingSummary {
  const section = (name: string): string => {
    const pattern = new RegExp(`\\*{0,2}${escapeRegex(name)}:?\\*{0,2}:?[ \\t]*\\n?([\\s\\S]*?)(?=\\n\\s*\\*{0,2}[A-Z][A-Z \\-]{2,}:?\\*{0,2}:?\\s*\\n|$)`, "i")
    return text.match(pattern)?.[1]?.trim() ?? ""
  }
  const bullets = (body: string): string[] =>
    body
      .split("\n")
      .map((l) => l.replace(/^[\s•\-*\d.)]+/, "").trim())
      .filter((l) => l.length > 0 && !/^\(.*\)$/.test(l))
      .slice(0, 12)

  const overviewRaw = section(SECTIONS.overview)
  return {
    title: section(SECTIONS.title).split("\n")[0].replace(/^["']|["']$/g, "").trim(),
    overview: overviewRaw.replace(/^\(.*\)$/, "").trim(),
    keyPoints: bullets(section(SECTIONS.keyPoints)),
    decisions: bullets(section(SECTIONS.decisions)),
    actionItems: bullets(section(SECTIONS.actionItems)),
    nextSteps: bullets(section(SECTIONS.nextSteps)),
    followUpQuestions: bullets(section(SECTIONS.followUpQuestions)),
    topics: bullets(section(SECTIONS.topics)),
    generatedAt: Date.now(),
    language
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
