import OpenAI from "openai"
import { APP_TOKEN, relayHttpUrl } from "../../shared/relay"
import { getLanguage, type LanguageCode, type OwnKey } from "../../shared/types"
import { describeOwnKeyError, PLAIN_BOX, reasoningFor, type SecretBox } from "./ownKey"
import { relayIdentity } from "./relayAuth"
import type { SettingsStore } from "./settings"
import { t } from "../../shared/i18n"

export interface LlmMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LlmResult {
  text: string
  tokens: number
}

/**
 * What a request is for. The relay picks the model for each task from its own config
 * (and falls back on its own), so changing models never needs an app release.
 */
export type LlmTask = "answer" | "auto" | "suggest" | "vision" | "report"

/** The wire format needs a model name; the relay ignores it. */
const RELAY_MODEL = "relay"

interface Route {
  client: OpenAI
  model: string
  headers: Record<string, string>
  /** Set when the request goes to the user's own endpoint. */
  own: OwnKey | null
}

/**
 * Chat and vision through the relay, or straight to the user's own OpenAI-compatible endpoint when one
 * is set. Both speak the OpenAI wire format, so the official client works unchanged.
 */
export class Llm {
  private readonly relay: OpenAI
  private own: { signature: string; client: OpenAI } | null = null

  constructor(
    private readonly settings: Pick<SettingsStore, "get" | "deviceId" | "appVersion">,
    relayUrl = process.env.IGPT_RELAY_URL || undefined,
    private readonly box: SecretBox = PLAIN_BOX
  ) {
    this.relay = new OpenAI({
      apiKey: APP_TOKEN,
      baseURL: `${relayHttpUrl(relayUrl)}/v1`,
      maxRetries: 1,
      timeout: 90_000
    })
  }

  languageInstruction(code?: LanguageCode): string {
    return getLanguage(code ?? this.settings.get().outputLanguage).instruction
  }

  /** Read per request: the own key can be set or removed at any time. */
  private route(task: LlmTask): Route {
    const own = this.settings.get().ownKey
    if (!own) return { client: this.relay, model: RELAY_MODEL, headers: { ...relayIdentity(this.settings), "X-Meetingly-Task": task }, own: null }
    const key = own.key ? this.box.decrypt(own.key) : ""
    const signature = `${own.baseUrl}
${key}`
    if (this.own?.signature !== signature) {
      this.own = { signature, client: new OpenAI({ apiKey: key || "none", baseURL: own.baseUrl, maxRetries: 1, timeout: 90_000 }) }
    }
    return { client: this.own.client, model: own.model, headers: {}, own }
  }

  /** Chat completion; streams through `onChunk` when provided. */
  async chat(messages: LlmMessage[], onChunk?: (delta: string) => void, task: LlmTask = "answer"): Promise<LlmResult> {
    const route = this.route(task)
    const params = { model: route.model, messages, ...(route.own ? reasoningFor(route.model) : {}) }
    try {
      if (!onChunk) {
        const res = await route.client.chat.completions.create(params, { headers: route.headers })
        return { text: res.choices[0]?.message?.content ?? "", tokens: res.usage?.total_tokens ?? 0 }
      }
      const stream = await route.client.chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        { headers: route.headers }
      )
      let text = ""
      let tokens = 0
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          text += delta
          onChunk(delta)
        }
        if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens
      }
      return { text, tokens }
    } catch (err) {
      throw route.own ? describeOwnKeyError(err, route.own) : err
    }
  }

  /** Describe a JPEG screenshot. */
  async vision(base64Jpeg: string, prompt: string, system?: string): Promise<LlmResult> {
    const route = this.route("vision")
    try {
      const res = await route.client.chat.completions.create(
        {
          model: route.model,
          ...(route.own ? reasoningFor(route.model) : {}),
          messages: [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` } }
              ]
            }
          ]
        },
        { headers: route.headers }
      )
      return { text: res.choices[0]?.message?.content ?? "", tokens: res.usage?.total_tokens ?? 0 }
    } catch (err) {
      throw route.own ? describeOwnKeyError(err, route.own) : err
    }
  }
}

/** Turn relay / network failures into something a person can act on. */
export function describeRelayError(err: unknown): string {
  // Errors from the user's own endpoint are already worded (see describeOwnKeyError).
  if (err instanceof Error && (err as { ownKey?: boolean }).ownKey) return err.message
  const status = (err as { status?: number })?.status
  // Limits, sign-in and plan errors come with a code; word them in the interface language.
  const relay = (err as { error?: RelayError })?.error
  if (relay?.code && relay.message) return relayMessage(relay)
  const message = err instanceof Error ? err.message : String(err)
  if (status === 401) return t("This build of Meetingly is no longer accepted by the server. Please update the app.")
  if (status === 429) return /transcription/i.test(message) ? t("Daily transcription limit reached. Try again tomorrow.") : t("Daily limit reached. Try again tomorrow.")
  if (status === 402) return t("The service is temporarily out of credits. Try again later.")
  if (status && status >= 500) return t("The Meetingly server is having trouble. Try again in a minute.")
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|Connection error/i.test(message)) return t("Cannot reach the Meetingly server. Check your internet connection.")
  return message
}

interface RelayError {
  code: string
  message: string
  plan?: string | null
  limit?: number
  hours?: number
}

/** The relay's limit and sign-in errors in the interface language (its own English words otherwise). */
function relayMessage(e: RelayError): string {
  const upgrade = e.plan === "free" ? ` ${t("Upgrade to Pro for more.")}` : e.plan === "guest" ? ` ${t("Update Meetingly and sign in to keep going.")}` : ""
  const n = e.limit ?? 0
  switch (e.code) {
    case "account_required":
      return t("Create a free Meetingly account to use AI answers: click Sign up free at the bottom of the panel.")
    case "account_unavailable":
      return t("The account service is unavailable. Try again in a minute.")
    case "answers_limit":
      return e.plan === "pro" ? t("You've reached today's fair-use limit of answers. It resets at midnight UTC.") : t("You've used today's {n} free answers.", { n }) + upgrade
    case "listening_limit":
      return t("Live suggestions and auto-answer are paused: today's {hours} hours are used up. Questions you ask still work.", { hours: e.hours ?? "" }) + upgrade
    case "vision_limit":
      return t("You've used today's {n} screen analyses.", { n }) + upgrade
    case "reports_limit":
      return t("You've used today's {n} meeting reports.", { n }) + upgrade
    case "daily_limit":
      return t("Today's usage limit is reached. It resets at midnight UTC.") + upgrade
    case "busy":
      return t("Another request is still running. Try again in a moment.")
    case "rate_limit":
      return t("Too many requests at once. Slow down a little.")
    case "network_limit":
      return t("Too many free answers from this network today. It resets at midnight UTC.")
    default:
      return e.message
  }
}
