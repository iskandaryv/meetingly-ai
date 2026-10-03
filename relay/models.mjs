// Which upstream model serves a request. The app never names a model: it labels each request
// with its task (X-Meetingly-Task) and this config decides, so changing models is a relay
// restart, not an app release. Older builds that still send a model name get the config too.

export const TASKS = ["answer", "suggest", "vision", "report"]

/** DEFAULT_MODEL for everything, MODEL_<TASK> to override one task, FALLBACK_MODEL when the first choice fails. */
export function modelConfig(env) {
  const clean = (value) => (value ?? "").trim()
  const perTask = {}
  for (const task of TASKS) {
    const model = clean(env[`MODEL_${task.toUpperCase()}`])
    if (model) perTask[task] = model
  }
  return { default: clean(env.DEFAULT_MODEL) || "gpt-5.6-luna", fallback: clean(env.FALLBACK_MODEL), perTask }
}

/** Models to try in order. A missing or unknown task gets the default. */
export function modelsFor(config, task) {
  const first = Object.hasOwn(config.perTask, task) ? config.perTask[task] : config.default
  return config.fallback && config.fallback !== first ? [first, config.fallback] : [first]
}
