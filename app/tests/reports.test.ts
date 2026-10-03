import { describe, expect, it } from "vitest"
import { buildReportPrompt, parseReport } from "../electron/services/reports"
import type { Meeting } from "../shared/types"

const sample = `**TITLE:**
Q3 roadmap sync

**OVERVIEW:**
The team aligned on the Q3 roadmap and agreed to ship the billing revamp first.
Marketing needs two weeks of notice.

**KEY POINTS:**
- Billing revamp is the top priority
- Mobile app slips to Q4
* Hiring freeze continues

**DECISIONS:**
- Ship billing before the mobile beta

**ACTION ITEMS:**
1. Anna drafts the billing spec by Friday
2. Ben books the marketing sync

**NEXT STEPS:**

**FOLLOW-UP QUESTIONS:**
- Who owns the migration runbook?

**TOPICS:**
- billing
- roadmap`

describe("parseReport", () => {
  it("extracts every section and normalizes bullets", () => {
    const s = parseReport(sample, "en")
    expect(s.title).toBe("Q3 roadmap sync")
    expect(s.overview).toContain("aligned on the Q3 roadmap")
    expect(s.overview).toContain("two weeks of notice")
    expect(s.keyPoints).toEqual(["Billing revamp is the top priority", "Mobile app slips to Q4", "Hiring freeze continues"])
    expect(s.decisions).toEqual(["Ship billing before the mobile beta"])
    expect(s.actionItems).toEqual(["Anna drafts the billing spec by Friday", "Ben books the marketing sync"])
    expect(s.nextSteps).toEqual([])
    expect(s.followUpQuestions).toEqual(["Who owns the migration runbook?"])
    expect(s.topics).toEqual(["billing", "roadmap"])
    expect(s.language).toBe("en")
  })

  it("tolerates headers without markdown bold", () => {
    const s = parseReport("TITLE:\nPlain title\nOVERVIEW:\nShort.\nKEY POINTS:\n- one", "ru")
    expect(s.title).toBe("Plain title")
    expect(s.overview).toBe("Short.")
    expect(s.keyPoints).toEqual(["one"])
  })

  it("returns empty fields for garbage", () => {
    const s = parseReport("no structure at all", "en")
    expect(s.title).toBe("")
    expect(s.keyPoints).toEqual([])
  })
})

describe("buildReportPrompt", () => {
  it("includes the transcript and every header", () => {
    const meeting: Meeting = {
      id: "m1",
      title: "t",
      startTime: 0,
      endTime: 120000,
      duration: 120000,
      transcript: [],
      fullTranscriptText: "hello world",
      language: "en",
      status: "processing",
      createdAt: 0,
      updatedAt: 0
    }
    const prompt = buildReportPrompt(meeting)
    expect(prompt).toContain("hello world")
    for (const h of ["TITLE", "OVERVIEW", "KEY POINTS", "DECISIONS", "ACTION ITEMS", "NEXT STEPS", "FOLLOW-UP QUESTIONS", "TOPICS"]) {
      expect(prompt).toContain(`**${h}:**`)
    }
  })
})
