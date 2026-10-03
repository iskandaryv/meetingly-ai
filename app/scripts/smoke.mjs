// Builds the app, launches Electron in smoke mode and prints its report.
//   node scripts/smoke.mjs            windows only
//   node scripts/smoke.mjs chat       + one LLM round-trip through the relay
//   node scripts/smoke.mjs listen     + real microphone and system-audio sessions (opens the mic!)
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const electronBin = require("electron")

const build = spawnSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit", shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

const run = spawnSync(electronBin, ["."], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, IGPT_SMOKE: process.argv[2] || "1", ELECTRON_ENABLE_LOGGING: "1" },
  timeout: 120000
})
const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
const line = out.split("\n").find((l) => l.includes("SMOKE_REPORT"))
if (!line) {
  console.error(out)
  console.error("smoke: no report produced")
  process.exit(1)
}
const report = JSON.parse(line.slice(line.indexOf("{")))
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
