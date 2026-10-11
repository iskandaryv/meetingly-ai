import type { Settings } from "../../shared/types"

/** Only an owned top-level renderer may invoke privileged main-process handlers. */
export function trustedFrame(owned: boolean, senderFrame: unknown, mainFrame: unknown): boolean {
  return owned && Boolean(senderFrame) && senderFrame === mainFrame
}

const EDITABLE = new Set([
  "outputLanguage", "audioLanguage", "audioSource", "transcriptionEngine", "audioDeviceId",
  "autoAnswer", "answerLength", "suggestions", "stealth", "autoLaunch", "prompts", "activePromptId", "shortcuts"
])

/** Account identity and credentials can only change through their dedicated main-process flows. */
export function rendererSettingsPatch(input: unknown): Partial<Settings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings update")
  const entries = Object.entries(input).filter(([key]) => EDITABLE.has(key))
  for (const [key, value] of entries) {
    if (["autoLaunch", "stealth", "suggestions"].includes(key) && typeof value !== "boolean") {
      throw new Error(`Invalid ${key}: expected a boolean`)
    }
  }
  return Object.fromEntries(entries) as Partial<Settings>
}
