import OpenAI from "openai"
import type { OwnKey, OwnKeyInput } from "../../shared/types"
import { t } from "../../shared/i18n"
import type { SettingsStore } from "./settings"

/** Keeps the API key encrypted at rest: Electron's safeStorage (the OS keychain) in the app. */
export interface SecretBox {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

/** No encryption: tests, and systems without a keychain. */
export const PLAIN_BOX: SecretBox = { encrypt: (s) => s, decrypt: (s) => s }

/** The base URL as people paste it: with or without a trailing slash or /chat/completions. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "")
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** gpt-5.x and o-series models think before answering; low effort keeps answers fast. Other models reject the field. */
export function reasoningFor(model: string): { reasoning_effort?: "low" } {
  const name = model.split("/").pop() ?? model
  return /^(gpt-5|o[1-9])/i.test(name) ? { reasoning_effort: "low" } : {}
}

/** A provider error in words a person can act on. Marked so the relay's wording is never applied to it. */
export function describeOwnKeyError(err: unknown, own: Pick<OwnKey, "baseUrl" | "model">): Error {
  const status = (err as { status?: number })?.status
  const host = hostOf(own.baseUrl)
  const raw = (err as { error?: { message?: string } })?.error?.message ?? (err instanceof Error ? err.message : String(err))
  const detail = raw.replace(/\s+/g, " ").slice(0, 200)
  let message: string
  if (status === 401 || status === 403) message = t("{host} rejected the API key. Check the key and try again.", { host })
  else if (status === 404) message = t("{host} answered 404: check the API address and the model name ({model}).", { host, model: own.model })
  else if (status === 429) message = t("{host} says you are over your rate limit or out of credits.", { host })
  else if (status) message = t("{host} answered with an error ({status}): {detail}", { host, status, detail })
  else message = t("Cannot reach {host}: {detail}", { host, detail })
  return Object.assign(new Error(message), { ownKey: true })
}

interface Deps {
  settings: Pick<SettingsStore, "get" | "update">
  box: SecretBox
  fetch?: typeof fetch
}

/**
 * The "use your own API key" setup: list the endpoint's models, check a choice with one tiny request,
 * save it. The key never reaches the renderer and never syncs to the account.
 */
export class OwnKeyService {
  constructor(private readonly deps: Deps) {}

  /** The key to use: the one typed now, else the saved one when the endpoint is unchanged. */
  private keyFor(input: OwnKeyInput): string {
    if (input.key.trim()) return input.key.trim()
    const saved = this.deps.settings.get().ownKey
    return saved?.key && normalizeBaseUrl(saved.baseUrl) === normalizeBaseUrl(input.baseUrl) ? this.deps.box.decrypt(saved.key) : ""
  }

  async models(input: OwnKeyInput): Promise<string[]> {
    const base = normalizeBaseUrl(input.baseUrl)
    const key = this.keyFor(input)
    const res = await (this.deps.fetch ?? fetch)(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw describeOwnKeyError({ status: res.status, message: await res.text().catch(() => "") }, { baseUrl: base, model: "" })
    const body = (await res.json()) as { data?: { id?: unknown }[] }
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .sort()
  }

  /** Checks the address, key and model with a one-word request, then saves them. */
  async save(input: OwnKeyInput): Promise<void> {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    if (!/^https?:\/\/[^/]+/i.test(baseUrl)) throw new Error(t("Enter the API address, starting with https://"))
    const model = (input.model ?? "").trim()
    if (!model) throw new Error(t("Choose a model."))
    const key = this.keyFor(input)
    const client = new OpenAI({ apiKey: key || "none", baseURL: baseUrl, maxRetries: 0, timeout: 30_000, fetch: this.deps.fetch })
    try {
      await client.chat.completions.create({ model, messages: [{ role: "user", content: "Reply with the word OK." }], ...reasoningFor(model) })
    } catch (err) {
      throw describeOwnKeyError(err, { baseUrl, model })
    }
    this.deps.settings.update({ ownKey: { baseUrl, model, key: key ? this.deps.box.encrypt(key) : "" } })
  }

  clear(): void {
    this.deps.settings.update({ ownKey: null })
  }
}
