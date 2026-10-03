// Downloads the transcribe.cpp native library (on-device speech recognition) for every
// platform into vendor/transcribe/<os>-<arch>. Run once after cloning: npm run fetch:asr
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "0.2.4"
const TARGETS = {
  "win-x64": "windows-x86_64-cpu-vulkan",
  "mac-arm64": "macos-arm64-metal",
  "mac-x64": "macos-x86_64-cpu",
  "linux-x64": "linux-x86_64-cpu-vulkan"
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
for (const [dir, asset] of Object.entries(TARGETS)) {
  const dest = path.join(root, "vendor", "transcribe", dir)
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    console.log(`${dir}: present`)
    continue
  }
  const url = `https://github.com/handy-computer/transcribe.cpp/releases/download/v${VERSION}/transcribe-native-${VERSION}-${asset}.tar.gz`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-"))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  fs.writeFileSync(path.join(tmp, "a.tgz"), Buffer.from(await res.arrayBuffer()))
  execSync(`tar xzf a.tgz`, { cwd: tmp })
  const inner = fs.readdirSync(tmp).find((n) => n !== "a.tgz")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(path.join(tmp, inner), dest)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`${dir}: ${asset} ${VERSION}`)
}
