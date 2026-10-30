import { AsrModel, REFINE_MODELS, type RefineModelId } from "./asrModel"
import type { LanguageCode } from "../../shared/types"
import type { RefineOptions } from "./localAsr"

/**
 * The second pass: which model writes each finished utterance again, per meeting language. Chosen by measurement
 * (asrModel.ts); a language is here only where its model clearly beat the live one. The others keep the live text.
 */
export const REFINE_BY_LANGUAGE: Partial<Record<LanguageCode, RefineModelId>> = {
  en: "parakeet", bg: "parakeet", hr: "parakeet", cs: "parakeet", da: "parakeet", nl: "parakeet", et: "parakeet",
  fi: "parakeet", fr: "parakeet", de: "parakeet", hu: "parakeet", it: "parakeet", pl: "parakeet", pt: "parakeet",
  ro: "parakeet", ru: "parakeet", sk: "parakeet", es: "parakeet", sv: "parakeet", uk: "parakeet",
  zh: "qwen", ja: "qwen", ko: "qwen", vi: "qwen"
  // Arabic, Hindi, Turkish (Qwen3-ASR was worse or no better) and Norwegian (no model measured) keep the live text.
}

/**
 * The second-pass models in the models folder: each is downloaded once, the first time a meeting language needs it
 * (never more than the one in use). MEETINGLY_REFINE=0 turns the second pass off.
 */
export class RefineModels {
  private readonly models: Record<RefineModelId, AsrModel>
  private readonly downloading = new Set<RefineModelId>()

  constructor(dir: string) {
    this.models = Object.fromEntries(Object.entries(REFINE_MODELS).map(([id, spec]) => [id, new AsrModel(dir, spec)])) as Record<RefineModelId, AsrModel>
  }

  /** The second pass for a meeting language when its model is on disk; otherwise null, and the download starts. */
  forLanguage(code: LanguageCode): RefineOptions | null {
    const id = REFINE_BY_LANGUAGE[code]
    if (!id || process.env.MEETINGLY_REFINE === "0") return null
    const model = this.models[id]
    if (model.isReady()) return { modelPath: model.path, language: code }
    this.prefetch(code)
    return null
  }

  /** Downloads the language's second-pass model in the background, if it has one and it isn't here yet. */
  prefetch(code: LanguageCode): void {
    const id = REFINE_BY_LANGUAGE[code]
    if (!id || process.env.MEETINGLY_REFINE === "0" || this.downloading.has(id)) return
    const model = this.models[id]
    if (model.isReady()) return
    this.downloading.add(id)
    let logged = -10
    const onProgress = (p: number) => {
      if (p < logged + 10) return
      logged = p
      console.info("[asr-model]", `${model.model.file} ${p}%`)
    }
    model.on("progress", onProgress)
    void model
      .ensure()
      .then(
        () => console.info("[asr-model]", `${model.model.file} ready`),
        (err) => console.warn("[asr-model]", `${model.model.file} download failed:`, (err as Error).message)
      )
      .finally(() => {
        model.off("progress", onProgress)
        this.downloading.delete(id)
      })
  }
}
