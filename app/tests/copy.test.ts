import { describe, expect, it } from "vitest"
import { contextMenuTemplate, isCopyChord } from "../electron/copy-menu"
import { markdownToPlain } from "../src/lib/plain-text"

describe("copying an answer", () => {
  it("drops markdown markers and keeps the content", () => {
    const answer = "**Kafka is a distributed event-streaming platform.**\n- Producers write to `topics`\n* Consumers *read* at their own pace\n## Notes\nSee [docs](https://kafka.apache.org)"
    expect(markdownToPlain(answer)).toBe(
      "Kafka is a distributed event-streaming platform.\n- Producers write to topics\n- Consumers read at their own pace\nNotes\nSee docs (https://kafka.apache.org)"
    )
  })

  it("keeps code blocks as they are, without the fences", () => {
    expect(markdownToPlain("**Use a map.**\n```js\nconst a = { b: 2 * 3 }\n```")).toBe("Use a map.\nconst a = { b: 2 * 3 }")
  })

  it("leaves multiplication and snake_case alone", () => {
    expect(markdownToPlain("2 * 3 * 4 and user_id_field")).toBe("2 * 3 * 4 and user_id_field")
  })
})

describe("Ctrl+C as a shortcut", () => {
  it("is recognised however it is written", () => {
    for (const a of ["CommandOrControl+C", "CmdOrCtrl+c", "Ctrl+C", "Control + C", "Command+C"]) expect(isCopyChord(a)).toBe(true)
    for (const a of ["CommandOrControl+Shift+C", "Alt+C", "CommandOrControl+V", "CommandOrControl+Space"]) expect(isCopyChord(a)).toBe(false)
  })
})

describe("right-click menu", () => {
  const flags = { canCut: true, canCopy: true, canPaste: true, canUndo: false, canRedo: false, canDelete: false, canSelectAll: true, canEditRichly: false }

  it("offers Copy on selected text and nothing on plain clicks", () => {
    expect(contextMenuTemplate({ isEditable: false, selectionText: "an answer", editFlags: flags }).map((i) => i.role)).toEqual(["copy"])
    expect(contextMenuTemplate({ isEditable: false, selectionText: "  ", editFlags: flags })).toEqual([])
  })

  it("offers the editing items in text boxes", () => {
    const items = contextMenuTemplate({ isEditable: true, selectionText: "", editFlags: { ...flags, canCut: false, canCopy: false } })
    expect(items.map((i) => i.role ?? i.type)).toEqual(["cut", "copy", "paste", "separator", "selectAll"])
    expect(items[0].enabled).toBe(false)
    expect(items[2].enabled).toBe(true)
  })
})
