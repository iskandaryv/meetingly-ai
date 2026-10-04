/**
 * The account / sync service (account.meetinglyai.com). Separate from the AI relay.
 * Override for development with IGPT_CLOUD_URL (e.g. http://127.0.0.1:8091 over an ssh tunnel).
 */
export const CLOUD_URL = "https://account.meetinglyai.com"

export function cloudUrl(base?: string): string {
  return (base || CLOUD_URL).replace(/\/+$/, "")
}

export interface CloudAccount {
  url: string
  /** The device's own token (revoked when the device is unlinked); never shown in the UI. */
  token: string
  userId: string
  email: string
  name?: string
  linkedAt: number
}

export type CloudStatus = "off" | "linking" | "online" | "offline" | "error"

export interface CloudState {
  status: CloudStatus
  email?: string
  /** While linking: the code the user must see in the browser. */
  code?: string
  linkUrl?: string
  lastSync?: number
  error?: string
}

/** Keys of Settings that follow the account across devices. */
export const CLOUD_SETTING_KEYS = ["outputLanguage", "audioLanguage", "audioSource", "autoAnswer", "answerLength", "stealth", "autoLaunch", "shortcuts"] as const
export type CloudSettingKey = (typeof CLOUD_SETTING_KEYS)[number]
