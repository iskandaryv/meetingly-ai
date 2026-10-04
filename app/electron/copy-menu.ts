import type { ContextMenuParams, MenuItemConstructorOptions } from "electron"
import { t } from "../shared/i18n"

/** Ctrl+C / Cmd+C, however the user wrote it in Settings. */
export function isCopyChord(accelerator: string): boolean {
  return /^(CommandOrControl|CmdOrCtrl|Control|Ctrl|Command|Cmd)\+C$/i.test(accelerator.replace(/\s+/g, ""))
}

/**
 * True when the page has text selected: inside the focused text box, or anywhere in the page (the chat box
 * can keep focus while an answer is selected).
 */
export const HAS_SELECTION_JS = `(() => {
  const el = document.activeElement
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && typeof el.selectionStart === "number" && el.selectionEnd > el.selectionStart) return true
  const s = window.getSelection()
  return Boolean(s && s.toString().trim())
})()`

/** The right-click menu: the usual editing items in text boxes, Copy on selected text, nothing elsewhere. */
export function contextMenuTemplate(params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: "cut", label: t("Cut"), enabled: params.editFlags.canCut },
      { role: "copy", label: t("Copy"), enabled: params.editFlags.canCopy },
      { role: "paste", label: t("Paste"), enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: t("Select all") }
    ]
  }
  return params.selectionText.trim() ? [{ role: "copy", label: t("Copy") }] : []
}
