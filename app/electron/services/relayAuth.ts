import type { SettingsStore } from "./settings"

/**
 * Headers that tell the relay who is calling: this install, this app version (builds before accounts
 * sent none, and get the small guest allowance), and the linked account, whose plan sets the limits.
 * Read per request: the account token changes when the account is linked, refreshed or disconnected.
 */
export function relayIdentity(settings: Pick<SettingsStore, "get" | "deviceId" | "appVersion">): Record<string, string> {
  const headers: Record<string, string> = { "X-Device-Id": settings.deviceId(), "X-Meetingly-Client": settings.appVersion() }
  const token = settings.get().cloud?.token
  if (token) headers["X-Meetingly-Account"] = token
  return headers
}
