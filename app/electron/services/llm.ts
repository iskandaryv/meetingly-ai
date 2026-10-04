import OpenAI from "openai"
import { APP_TOKEN, relayHttpUrl } from "../../shared/relay"
import { getLanguage, type LanguageCode } from "../../shared/types"
import { relayIdentity } from "./relayAuth"
import type { SettingsStore } from "./settings"

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

/**
 * Chat and vision through the relay. The relay speaks the OpenAI wire format,
 * so the official client works unchanged; it just points at our server.
 */
export class Llm {
  private readonly client: OpenAI

  constructor(private readonly settings: SettingsStore, relayUrl = process.env.IGPT_RELAY_URL || undefined) {
    this.client = new OpenAI({
      apiKey: APP_TOKEN,
      baseURL: `${relayHttpUrl(relayUrl)}/v1`,
      maxRetries: 1,
      timeout: 90_000
    })
  }

  languageInstruction(code?: LanguageCode): string {
    return getLanguage(code ?? this.settings.get().outputLanguage).instruction
  }

  /** Chat completion; streams through `onChunk` when provided. */
  async chat(messages: LlmMessage[], onChunk?: (delta: string) => void, task: LlmTask = "answer"): Promise<LlmResult> {
    const options = { headers: { ...relayIdentity(this.settings), "X-Meetingly-Task": task } }
    if (!onChunk) {
      const res = await this.client.chat.completions.create({ model: RELAY_MODEL, messages }, options)
      return { text: res.choices[0]?.message?.content ?? "", tokens: res.usage?.total_tokens ?? 0 }
    }
    const stream = await this.client.chat.completions.create(
      { model: RELAY_MODEL, messages, stream: true, stream_options: { include_usage: true } },
      options
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
  }

  /** Describe a JPEG screenshot. */
  async vision(base64Jpeg: string, prompt: string, system?: string): Promise<LlmResult> {
    const res = await this.client.chat.completions.create(
      {
        model: RELAY_MODEL,
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
      { headers: { ...relayIdentity(this.settings), "X-Meetingly-Task": "vision" satisfies LlmTask } }
    )
    return { text: res.choices[0]?.message?.content ?? "", tokens: res.usage?.total_tokens ?? 0 }
  }
}

/** Turn relay / network failures into something a person can act on. */
export function describeRelayError(err: unknown): string {
  const status = (err as { status?: number })?.status
  // Limits, sign-in and plan errors come with a code and words meant for the user: show them as they are.
  const relay = (err as { error?: { code?: string; message?: string } })?.error
  if (relay?.code && relay.message) return relay.message
  const message = err instanceof Error ? err.message : String(err)
  if (status === 401) return "This build of Meetingly is no longer accepted by the server. Please update the app."
  if (status === 429) return /transcription/i.test(message) ? "Daily transcription limit reached. Try again tomorrow." : "Daily limit reached. Try again tomorrow."
  if (status === 402) return "The service is temporarily out of credits. Try again later."
  if (status && status >= 500) return "The Meetingly server is having trouble. Try again in a minute."
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|Connection error/i.test(message)) return "Cannot reach the Meetingly server. Check your internet connection."
  return message
}
