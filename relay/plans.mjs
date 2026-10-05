// Daily budgets per plan (UTC day). The account service decides the plan; this file decides what it buys.
// The dashboard's Plan page shows these numbers too (meetingly-cloud lib/app-types.ts PLAN_ROWS): keep in step.
// rpm = requests per minute per account; concurrent = requests at once; audioMinutes = cloud transcription
// (Deepgram), which only Unlimited includes: every other plan transcribes on the user's computer.

export const PLANS = {
  // Builds from before accounts (1.0.0): a small allowance per IP until they update, then nothing.
  // They still transcribe in the cloud, so they keep their minutes; every other number is at most Free's.
  guest: { answers: 20, vision: 3, listening: 60, reports: 1, tokens: 60_000, audioMinutes: 30, concurrent: 1, rpm: 15 },
  free: { answers: 50, vision: 3, listening: 90, reports: 1, tokens: 100_000, audioMinutes: 0, concurrent: 2, rpm: 15 },
  pro: { answers: 300, vision: 50, listening: 720, reports: 20, tokens: 1_500_000, audioMinutes: 0, concurrent: 3, rpm: 30 },
  // "Unlimited" in the UI; these are fair-use ceilings no real meeting schedule reaches.
  unlimited: { answers: 2000, vision: 300, listening: 1440, reports: 100, tokens: 4_000_000, audioMinutes: 480, concurrent: 4, rpm: 60 }
}

/** Plans someone pays for: no per-network cap, and the fair-use wording. */
export const PAID = new Set(["pro", "unlimited"])

/** A plan name from anywhere, as one this relay knows (unknown names get the free budget). */
export function planName(name) {
  return Object.hasOwn(PLANS, name) ? name : "free"
}

/** Header-less builds (1.0.0) keep working until this date so they can auto-update. */
export const GUEST_UNTIL = Date.parse("2026-11-04T00:00:00Z")

/** All free and guest answers from one IP together: an office is fine, an account farm is not. */
export const IP_ANSWERS_PER_DAY = 600

/**
 * What each task may cost. `bucket` is checked before the request; `auto` (a hands-free check) also needs
 * listening budget, because a check that answers nothing is listening, not an answer.
 */
export const TASKS = {
  answer: { bucket: "answers", maxTokens: 2048 },
  auto: { bucket: "answers", alsoNeeds: "listening", maxTokens: 2048 },
  vision: { bucket: "vision", maxTokens: 2048 },
  suggest: { bucket: "listening", maxTokens: 700, noStream: true },
  report: { bucket: "reports", maxTokens: 4096 },
  "": { bucket: "answers", maxTokens: 2048 } // builds that send no task (1.0.0) only ever ask for answers
}

export function taskSpec(task) {
  return Object.hasOwn(TASKS, task) ? TASKS[task] : null
}

/**
 * The counter a finished request is charged to, from what the reply turned out to be
 * ("answer", "skip" or "empty", see answers.mjs). Null when it costs nothing but tokens.
 */
export function chargeFor(task, verdict) {
  switch (task) {
    case "auto":
      return verdict === "answer" ? "answers" : verdict === "skip" ? "listening" : null
    case "vision":
      return verdict === "answer" ? "vision" : null
    case "suggest":
      return "listening"
    case "report":
      return "reports"
    default:
      return verdict === "answer" ? "answers" : null
  }
}

const HOURS = (n) => `${Math.round((n * 20) / 3600 * 10) / 10}` // one listening call per ~20 s of conversation

/** Null when the request may go ahead; otherwise the 429 code and the message the app shows. */
const UPGRADE = {
  guest: " Update Meetingly and sign in to keep going.",
  free: " Upgrade for more.",
  pro: " Upgrade to Unlimited for more.",
  unlimited: ""
}

export function checkBudget(name, used, task) {
  name = planName(name)
  const plan = PLANS[name]
  const spec = taskSpec(task)
  const upgrade = UPGRADE[name]
  if ((used.tokens ?? 0) >= plan.tokens) return { code: "daily_limit", limit: plan.tokens, message: `Today's usage limit is reached. It resets at midnight UTC.${upgrade}` }
  const over = (field) => (used[field] ?? 0) >= plan[field]
  if (spec.bucket === "answers" && over("answers")) {
    const message =
      name === "unlimited"
        ? "You've reached today's fair-use limit of answers. It resets at midnight UTC."
        : `You've used today's ${plan.answers} ${name === "pro" ? "" : "free "}answers.${upgrade}`
    return { code: "answers_limit", limit: plan.answers, message }
  }
  if ((spec.bucket === "listening" || spec.alsoNeeds === "listening") && over("listening")) {
    return { code: "listening_limit", limit: plan.listening, hours: Number(HOURS(plan.listening)), message: `Live suggestions and auto-answer are paused: today's ${HOURS(plan.listening)} hours are used up. Questions you ask still work.${upgrade}` }
  }
  if (spec.bucket === "vision" && over("vision")) return { code: "vision_limit", limit: plan.vision, message: `You've used today's ${plan.vision} screen analyses.${upgrade}` }
  if (spec.bucket === "reports" && over("reports")) return { code: "reports_limit", limit: plan.reports, message: `You've used today's ${plan.reports} meeting reports.${upgrade}` }
  return null
}
