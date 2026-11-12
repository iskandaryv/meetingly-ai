import { describe, expect, it } from "vitest"
import { splitAnswerVariants } from "../src/lib/answer-variants"
import { composeSystemPrompt } from "../electron/services/chat"
import { DEFAULT_PROMPT } from "../shared/types"

describe("optional spoken answer", () => {
  it("preserves the original answer when the marker is absent", () => {
    expect(splitAnswerVariants("**Redis is fast.**\n- In memory")).toEqual({
      standard: "**Redis is fast.**\n- In memory", spoken: null
    })
  })

  it("separates the spoken version from the normal answer", () => {
    expect(splitAnswerVariants("**Fast.**\n- In memory\n[[SPOKEN]]\nRedis is fast because it keeps data in memory.")).toEqual({
      standard: "**Fast.**\n- In memory", spoken: "Redis is fast because it keeps data in memory."
    })
  })

  it("preserves whitespace and inline markers in ordinary answers", () => {
    for (const text of ["  Answer.\n", "Use [[SPOKEN]] as a separator."]) {
      expect(splitAnswerVariants(text)).toEqual({ standard: text, spoken: null })
    }
  })

  it("holds a marker split at every streaming boundary", () => {
    const marker = "[[SPOKEN]]"
    for (let i = 1; i <= marker.length; i++) {
      expect(splitAnswerVariants(`Answer.\n${marker.slice(0, i)}`)).toEqual({ standard: "Answer.", spoken: null })
    }
    expect(splitAnswerVariants("Answer.\r\n[[SPOKEN]]\r\nSay this.")).toEqual({ standard: "Answer.", spoken: "Say this." })
  })

  it("changes only the enabled prompt and retains the no-answer gate", () => {
    const normal = composeSystemPrompt(DEFAULT_PROMPT, { answerLength: "auto" }, "Answer in Chinese.")
    const dual = composeSystemPrompt(DEFAULT_PROMPT, { answerLength: "auto", spokenVariant: true }, "Answer in Chinese.")
    expect(composeSystemPrompt(DEFAULT_PROMPT, { answerLength: "auto", spokenVariant: false }, "Answer in Chinese.")).toBe(normal)
    expect(normal).not.toContain("[[SPOKEN]]")
    expect(dual).toContain("[[SPOKEN]]")
    expect(dual).toContain("[no-answer]")
  })
})
