// Which upstream model serves a request. The app never names a model: it labels each request
// with its task (X-Meetingly-Task) and this config decides, so changing models is a relay
// restart, not an app release. Older builds that still send a model name get the config too.

export const TASKS = ["answer", "suggest", "vision", "report"]
export const PLAN_NAMES = ["guest", "free", "pro", "unlimited"]

/**
 * DEFAULT_MODEL for everything; MODEL_<PLAN> for a plan, MODEL_<TASK> for a task on every plan,
 * MODEL_<PLAN>_<TASK> for one task on one plan. FALLBACK_MODEL (or FALLBACK_MODEL_<PLAN>) when the first
 * choice fails before sending anything.
 */
export function modelConfig(env) {
  const clean = (value) => (value ?? "").trim()
  const perTask = {}
  const perPlan = {}
  const perPlanTask = {}
  const fallbackPerPlan = {}
  for (const task of TASKS) {
    const model = clean(env[`MODEL_${task.toUpperCase()}`])
    if (model) perTask[task] = model
  }
  for (const plan of PLAN_NAMES) {
    const P = plan.toUpperCase()
    if (clean(env[`MODEL_${P}`])) perPlan[plan] = clean(env[`MODEL_${P}`])
    if (clean(env[`FALLBACK_MODEL_${P}`])) fallbackPerPlan[plan] = clean(env[`FALLBACK_MODEL_${P}`])
    for (const task of TASKS) {
      const model = clean(env[`MODEL_${P}_${task.toUpperCase()}`])
      if (model) perPlanTask[`${plan}:${task}`] = model
    }
  }
  return { default: clean(env.DEFAULT_MODEL) || "gpt-5.6-luna", fallback: clean(env.FALLBACK_MODEL), perTask, perPlan, perPlanTask, fallbackPerPlan }
}

/** Models to try in order: plan+task, then task, then plan, then the default; the fallback last. */
export function modelsFor(config, task, plan = "") {
  const first =
    config.perPlanTask?.[`${plan}:${task}`] ??
    (Object.hasOwn(config.perTask, task) ? config.perTask[task] : undefined) ??
    config.perPlan?.[plan] ??
    config.default
  const fallback = config.fallbackPerPlan?.[plan] || config.fallback
  return fallback && fallback !== first ? [first, fallback] : [first]
}

/**
 * Which upstream serves a model: Claude models have their own gateway (CLAUDE_BASE_URL / CLAUDE_API_KEY,
 * OpenAI-compatible chat completions); everything else goes to UPSTREAM_*. Without a Claude gateway
 * configured, Claude models go to the main upstream too.
 */
export function upstreamFor(model, upstreams) {
  return /^claude-/i.test(model) && upstreams.claude ? upstreams.claude : upstreams.main
}
