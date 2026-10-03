import type { RendererApi } from "@shared/ipc"

declare global {
  interface Window {
    api: RendererApi
  }
}

/** Typed bridge to the main process, installed by the preload script. */
export const api: RendererApi = window.api

/** Write a diagnostic into the app log file (same file as the main process). */
export function log(level: "debug" | "info" | "warn" | "error", scope: string, message: string, data?: unknown): void {
  void api.invoke("app:log", { level, scope, message, data }).catch(() => {})
}

export const isMac = api.platform === "darwin"
export const modKey = isMac ? "⌘" : "Ctrl"

/** Human label for an Electron accelerator. */
export function shortcutLabel(accelerator: string): string {
  return accelerator
    .replace("CommandOrControl", modKey)
    .replace("Alt", isMac ? "⌥" : "Alt")
    .replace("Shift", isMac ? "⇧" : "Shift")
    .replace("Enter", "↵")
    .replace("Left", "←")
    .replace("Right", "→")
    .replace("Up", "↑")
    .replace("Down", "↓")
    .replace(/\+/g, isMac ? "" : "+")
}
