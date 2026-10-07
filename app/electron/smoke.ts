import { app, BrowserWindow, clipboard, screen } from "electron"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { AsrModel } from "./services/asrModel"
import { LocalAsrSocket } from "./services/localAsr"
import type { AudioSource, WindowKind } from "../shared/types"
import type { ChatService } from "./services/chat"
import type { CloudSync } from "./services/cloud"
import type { MeetingStore } from "./services/meetings"
import type { RecordingSession } from "./services/session"
import type { SettingsStore } from "./services/settings"
import type { WindowManager } from "./windows/WindowManager"
import { SUGGESTIONS_WIDTH } from "./windows/config"
import { copySelection } from "./copy"
import { openOwnKeyForm } from "./ipc"

const KINDS: WindowKind[] = ["main", "chat"]

interface SmokeDeps {
  windows: WindowManager
  chat: ChatService
  session: RecordingSession
  settings: SettingsStore
  cloud: CloudSync
  meetings: MeetingStore
  asrModel: AsrModel
}

/**
 * Self checks driven by the IGPT_SMOKE env var:
 *   "1"       open every window, collect renderer errors, print a JSON report, exit.
 *   "chat"    same, plus one real chat round-trip through the relay.
 *   "listen"  same, plus a real listening session with the microphone and with
 *             system audio: the transcription socket must open and the renderer
 *             must keep the session in "recording" (capture errors pause it).
 *   "visual"  open every window with content protection off and stay running
 *             so the screen can be captured.
 *   "answers" auto-answer against the real model: English and Russian questions must get
 *             direct answers, small talk must be skipped (nothing shown in chat).
 *   "shots"   capture the toolbar and both panel tabs (with sample answers) as PNGs into
 *             IGPT_SMOKE_SHOTS. capturePage works even with content protection on.
 *   "demo"    frames of answers streaming in the panel, for the README animation (see demoFrames).
 *   "copy"    selecting an answer in the panel and pressing Ctrl+C copies it (the Ctrl+C shortcut must not
 *             swallow the copy); nothing selected means the copy path declines. Restores the clipboard.
 *   "hide"    hide everything with the toolbar eye button, bring it back every way a user can, use the chat button.
 *   "hardware" the same with the real cursor and a real Ctrl+B, starting like a real launch (no panel yet). Moves
 *             the cursor: for an unattended machine (the UI test workflow), not a desk someone is using.
 *   "ownkey"  the "use your own API key" flow in the real panel against a fake local endpoint (see ownKeySmoke).
 *   "asr"     on-device transcription: stream IGPT_SMOKE_WAV (16 kHz mono, played on the IGPT_SMOKE_SIDE
 *             channel, default "them") through the
 *             speech worker in real time and report partials, finals and latency.
 */
export async function runSmokeTest(mode: string, { windows, chat, session, settings, cloud, meetings, asrModel }: SmokeDeps): Promise<void> {
  const errors: string[] = []
  const loaded = new Set<WindowKind>()

  const attach = (kind: WindowKind) => {
    const win = windows.get(kind)
    if (!win) return
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(`[${kind}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    })
    win.webContents.on("did-fail-load", (_e, code, desc) => errors.push(`[${kind}] did-fail-load ${code} ${desc}`))
    win.webContents.on("render-process-gone", (_e, details) => errors.push(`[${kind}] renderer gone: ${details.reason}`))
    win.webContents.on("did-finish-load", () => loaded.add(kind))
  }

  attach("main")
  // "hardware" starts like a real launch: only the toolbar exists; the panel is created the first time it opens.
  const fresh = mode === "hardware"
  for (const kind of KINDS) {
    if (kind !== "main" && !fresh) {
      windows.show(kind)
      attach(kind)
    }
  }
  if (mode === "visual") windows.setStealth(false)

  await sleep(mode === "visual" ? 3000 : 6000)

  let chatProbe: { ok: boolean; reply?: string; error?: string; ms: number } | undefined
  if (mode === "chat") {
    const started = Date.now()
    const done = new Promise<{ ok: boolean; reply?: string; error?: string }>((resolve) => {
      chat.once("message", () => {
        chat.once("message", (m) => resolve(m.kind === "error" ? { ok: false, error: m.text } : { ok: true, reply: m.text }))
      })
    })
    await chat.send("Reply with exactly three words confirming you work.")
    chatProbe = { ...(await Promise.race([done, sleep(45000).then(() => ({ ok: false, error: "timeout" }))])), ms: Date.now() - started }
  }

  const listenProbe: Record<string, { ok: boolean; status: string; connected: boolean; notice: string | null; transcript?: string; heardPhrase?: boolean }> = {}
  if (mode === "listen") {
    const original = settings.get()
    for (const source of ["microphone", "system", "both"] as AudioSource[]) {
      settings.update({ audioSource: source, audioDeviceId: "", autoAnswer: "off" })
      try {
        await session.start()
        await sleep(2500)
        // System audio: play a known phrase through the speakers and expect it in the transcript.
        const spoke = source !== "microphone" ? await speakOnWindows(TEST_PHRASE) : false
        await sleep(spoke ? 9000 : 6000)
        const state = session.state()
        const transcript = session.transcriptText()
        // Diarization may split one sentence across speaker lines; compare words only.
        const words = transcript.toLowerCase().replace(/speaker \d+:/g, " ").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ")
        const heardPhrase = spoke ? words.includes("purple elephant") : undefined
        listenProbe[source] = {
          ok: state.status === "recording" && state.connected && heardPhrase !== false,
          status: state.status,
          connected: state.connected,
          notice: state.notice,
          transcript: transcript.slice(0, 200),
          heardPhrase
        }
      } catch (err) {
        listenProbe[source] = { ok: false, status: "error", connected: false, notice: (err as Error).message }
      }
      session.cancel()
      await sleep(1000)
    }
    settings.update({ audioSource: original.audioSource, audioDeviceId: original.audioDeviceId, autoAnswer: original.autoAnswer })
  }

  let cloudProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "cloud") cloudProbe = await cloudSmoke({ cloud, settings, meetings })

  if (mode === "shots") await shots(windows, process.env.IGPT_SMOKE_SHOTS || app.getPath("temp"))
  if (mode === "demo") await demoFrames(windows, process.env.IGPT_SMOKE_SHOTS || app.getPath("temp"))

  let answersProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "answers") answersProbe = await answersSmoke(chat, settings)

  let copyProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "copy") copyProbe = await copySmoke(windows)

  let hideProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "hide") hideProbe = await hideSmoke(windows)
  if (mode === "hardware") hideProbe = await hardwareSmoke(windows)

  let ownKeyProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "ownkey") ownKeyProbe = await ownKeySmoke(windows, chat, settings)

  let asrProbe: Record<string, unknown> & { ok: boolean } | undefined
  if (mode === "asr") asrProbe = await asrSmoke(asrModel, process.env.IGPT_SMOKE_WAV ?? "", process.env.IGPT_SMOKE_LANG ?? "en-US")

  const report = {
    mode,
    ok:
      errors.length === 0 &&
      loaded.size === (fresh ? 1 : KINDS.length) &&
      (chatProbe?.ok ?? true) &&
      Object.values(listenProbe).every((p) => p.ok) &&
      (cloudProbe?.ok ?? true) &&
      (asrProbe?.ok ?? true) &&
      (copyProbe?.ok ?? true) &&
      (ownKeyProbe?.ok ?? true) &&
      (hideProbe?.ok ?? true) &&
      (answersProbe?.ok ?? true),
    loaded: [...loaded],
    windows: Object.fromEntries(
      KINDS.map((k) => {
        const win = windows.get(k)
        return [k, win ? { visible: win.isVisible(), bounds: win.getBounds() } : null]
      })
    ),
    chat: chatProbe,
    listen: mode === "listen" ? listenProbe : undefined,
    cloud: cloudProbe,
    asr: asrProbe,
    copy: copyProbe,
    ownKey: ownKeyProbe,
    hide: hideProbe,
    answers: answersProbe,
    errors
  }
  console.log(`SMOKE_REPORT ${JSON.stringify(report)}`)
  if (mode !== "visual") app.exit(report.ok ? 0 : 1)
}

/**
 * Copying from the panel. The first checks call the copy path directly; the last one presses a real Ctrl+C
 * (SendKeys), which goes through the global shortcut exactly as when the user types it.
 */
async function copySmoke(windows: WindowManager): Promise<Record<string, unknown> & { ok: boolean }> {
  const saved = await clipboard.readText()
  const steps: Record<string, unknown> = {}
  const answer = "Sharding splits one database"
  try {
    windows.showPanel("answers")
    await sleep(1200)
    windows.send("chat", "chat:message", {
      id: "c1",
      role: "assistant",
      kind: "auto",
      text: "**Sharding splits one database into many by key.**\n- Pick a stable shard key\n- Route queries by key",
      timestamp: Date.now()
    })
    const panel = windows.get("chat")
    if (!panel) return { ok: false, steps, error: "no panel" }
    // The panel may still be loading: wait until the answer is on screen.
    for (let i = 0; i < 25; i++) {
      if (await panel.webContents.executeJavaScript("document.querySelectorAll('.md').length > 0").catch(() => false)) break
      await sleep(200)
    }
    panel.focus()
    await sleep(300)
    await clipboard.writeText("before")
    await panel.webContents.executeJavaScript("window.getSelection().removeAllRanges(); true")
    steps.noSelectionCopies = await copySelection(panel)
    const select =
      "(() => { const el = [...document.querySelectorAll('.md')].pop(); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString() })()"
    steps.selected = String(await panel.webContents.executeJavaScript(select)).slice(0, 60)
    const focused = BrowserWindow.getFocusedWindow()
    steps.focusedWindow = focused ? windows.kindOf(focused.webContents) : null
    steps.direct = await copySelection(panel)
    await sleep(200)
    steps.clipboardAfterDirect = (await clipboard.readText()).slice(0, 60)
    const directOk = steps.direct === true && (await clipboard.readText()).includes(answer)

    // Ctrl+C typed into the window itself (Chromium's own copy, now that Ctrl+C is no global shortcut).
    await clipboard.writeText("before")
    await panel.webContents.executeJavaScript(select)
    panel.webContents.sendInputEvent({ type: "keyDown", keyCode: "C", modifiers: ["control"] })
    panel.webContents.sendInputEvent({ type: "keyUp", keyCode: "C", modifiers: ["control"] })
    await sleep(500)
    steps.clipboardAfterWindowKey = (await clipboard.readText()).slice(0, 60)
    const windowKeyOk = (await clipboard.readText()).includes(answer)

    // The real key press, through Windows (and the global shortcut, if one is bound to Ctrl+C).
    let keyOk: boolean | undefined
    if (process.platform === "win32") {
      await clipboard.writeText("before")
      await panel.webContents.executeJavaScript(select)
      steps.focusedBeforeKey = panel.isFocused()
      await sendKeys("^c")
      await sleep(800)
      steps.clipboardAfterKey = (await clipboard.readText()).slice(0, 60)
      steps.panelVisibleAfterKey = panel.isVisible()
      keyOk = (await clipboard.readText()).includes(answer) && panel.isVisible()
    }
    // Informational: a smoke run started in the background is often not the OS foreground window, so a
    // synthetic key press may land elsewhere. The two checks above cover both ways Ctrl+C copies.
    return { ok: steps.noSelectionCopies === false && directOk && windowKeyOk, windowKey: windowKeyOk, keyPress: keyOk, steps }
  } catch (err) {
    return { ok: false, steps, error: (err as Error).message }
  } finally {
    await clipboard.writeText(saved)
  }
}

/** Types keys into whatever has focus (Windows), as a person would. */
function sendKeys(keys: string): Promise<void> {
  return new Promise((resolve) => {
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true })
    child.on("error", () => resolve())
    child.on("exit", () => resolve())
  })
}

const TEST_PHRASE = "The purple elephant is testing system audio capture."

/** Render sample content into the panel and save each window as a PNG (with alpha) plus its bounds. */
async function shots(windows: WindowManager, dir: string): Promise<void> {
  const now = Date.now()
  const sample = [
    { id: "s1", role: "user", kind: "auto", text: "What is Kafka?", timestamp: now },
    { id: "s2", role: "assistant", kind: "auto", text: "**Kafka is a distributed event-streaming platform for publishing, storing and processing real-time data.**\n- Producers write to topics\n- Consumers read at their own pace\n- Partitions scale it out\n- Replicated, so durable", timestamp: now },
    { id: "s3", role: "user", kind: "auto", text: "How would you scale the database as traffic grows?", timestamp: now },
    { id: "s4", role: "assistant", kind: "auto", text: "**I'd scale it in stages: find the bottleneck, fix queries and indexes, then add read replicas and shard by key.**\n- Profile the load first\n- Indexes and query plans\n- Read replicas for reads\n- Shard by merchant ID", timestamp: now }
  ] as const
  // A session in progress with the suggestions rail; "paused" shows it without starting audio capture.
  windows.setPanelExtra(SUGGESTIONS_WIDTH)
  windows.showPanel("answers")
  await sleep(1500)
  windows.send("chat", "session:state", { status: "paused", startedAt: now, notice: null, connected: true, audioSource: "both", audioDeviceId: "" })
  windows.send("chat", "suggestions:state", {
    topic: "Scaling the payments database",
    items: [
      { id: "q1", text: "What is database sharding and when is it needed?" },
      { id: "q2", text: "How does replication differ from sharding?" },
      { id: "q3", text: "How do you choose a shard key for a payments service?" },
      { id: "q4", text: "What is consumer lag in Kafka and how do you monitor it?" }
    ],
    updating: false
  })
  for (const m of sample) windows.send("chat", "chat:message", { ...m })
  await sleep(800)
  const save = async (name: string) => {
    for (const kind of ["main", "chat"] as WindowKind[]) {
      const win = windows.get(kind)
      if (!win) continue
      const img = await win.webContents.capturePage()
      fs.writeFileSync(`${dir}/${name}-${kind}.png`, img.toPNG())
      fs.writeFileSync(`${dir}/${name}-${kind}.json`, JSON.stringify(win.getBounds()))
    }
  }
  await save("answers")
  windows.showPanel("transcript")
  const said: [string, "you" | "them", boolean][] = [
    ["Thanks for joining! Tell me a bit about yourself and your experience.", "them", true],
    ["Hi! I've been a backend engineer for five years, mostly Go and Kafka.", "you", true],
    ["For the last two years I've owned our payments service.", "you", true],
    ["Great. How would you scale the database as traffic grows?", "them", true],
    ["And what would you do first if latency doubled overnight", "them", false]
  ]
  await sleep(400)
  for (const [text, channel, isFinal] of said) {
    windows.send("chat", "session:transcript", { text, isFinal, speechFinal: isFinal, confidence: 1, speaker: null, channel })
    await sleep(60)
  }
  await sleep(600)
  await save("transcript")
}

/**
 * Hide everything with the toolbar's eye button, bring it back each way a user can (Ctrl+B, the tray's
 * "Show toolbar", launching the app again), then use the toolbar's chat button. After every round the
 * windows must be where they belong, on top, and both renderers must answer quickly.
 */
async function hideSmoke(windows: WindowManager): Promise<Record<string, unknown> & { ok: boolean }> {
  const main = () => windows.get("main")!
  const panel = () => windows.get("chat")
  const click = (title: string) =>
    main().webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").startsWith(${JSON.stringify(title)})); if (b) b.click(); return Boolean(b) })()`) as Promise<boolean>
  const ping = async (kind: "main" | "chat") => {
    const win = kind === "main" ? main() : panel()
    if (!win) return -1
    const t0 = Date.now()
    await Promise.race([win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => r(1)))"), sleep(3000)])
    return Date.now() - t0
  }
  // On screen: shown and inside a display (a hidden toolbar on Windows is parked off-screen, still shown).
  const onScreen = () => main().isVisible() && screen.getAllDisplays().some((d) => { const b = main().getBounds(); const a = d.bounds; return b.x >= a.x && b.y >= a.y && b.x < a.x + a.width && b.y < a.y + a.height })
  const snap = async (label: string) => ({
    label,
    main: windows.isVisible("main"),
    mainOnScreen: onScreen(),
    chat: panel()?.isVisible() ?? false,
    mainOnTop: main().isAlwaysOnTop(),
    chatOnTop: panel()?.isAlwaysOnTop() ?? null,
    mainMs: await ping("main"),
    chatMs: await ping("chat"),
    windows: BrowserWindow.getAllWindows().length,
    toggleState: windows.state()
  })
  const rounds: Record<string, unknown>[] = []
  const problems: string[] = []
  const reopen: [string, () => void][] = [
    ["Ctrl+B (toggle all)", () => windows.toggleAll()],
    ["tray: Show toolbar", () => windows.centerMain()],
    ["launch again (second instance)", () => windows.centerMain()],
    ["Ctrl+B again", () => windows.toggleAll()]
  ]
  windows.showPanel("answers")
  await sleep(1200)
  for (const [route, open] of reopen) {
    for (const withPanel of [true, false]) {
      if (withPanel && !windows.isVisible("chat")) windows.showPanel("answers")
      if (!withPanel && windows.isVisible("chat")) windows.hide("chat")
      await sleep(300)
      if (!(await click("Hide all windows"))) problems.push("eye button not found")
      await sleep(500)
      const hidden = await snap(`${route}, panel ${withPanel ? "open" : "closed"}: hidden`)
      if (hidden.main || hidden.chat || hidden.mainOnScreen) problems.push(`${hidden.label}: something still visible`)
      open()
      await sleep(700)
      const back = await snap(`${route}: back`)
      if (!back.main || !back.mainOnScreen) problems.push(`${route}: toolbar didn't come back`)
      if (back.chat !== withPanel) problems.push(`${route}: panel ${withPanel ? "didn't come back" : "came back uninvited"}`)
      // Then the chat button, twice: it must close and open the panel (or open and close it).
      const first = back.chat
      await click("Answers and chat")
      await sleep(500)
      const afterOne = await snap(`${route}: chat button once`)
      await click("Answers and chat")
      await sleep(500)
      const afterTwo = await snap(`${route}: chat button twice`)
      if (afterOne.chat === first) problems.push(`${route}: first chat click did nothing (panel ${first ? "stayed open" : "stayed closed"})`)
      if (afterTwo.chat !== first) problems.push(`${route}: second chat click did nothing`)
      for (const s of [back, afterOne, afterTwo]) {
        if (s.main && !s.mainOnTop) problems.push(`${s.label}: toolbar lost always-on-top`)
        if (s.chat && s.chatOnTop === false) problems.push(`${s.label}: panel lost always-on-top`)
        if (s.mainMs > 500 || s.chatMs > 500) problems.push(`${s.label}: slow renderer (${s.mainMs} / ${s.chatMs} ms)`)
      }
      rounds.push(hidden, back, afterOne, afterTwo)
    }
  }
  return { ok: problems.length === 0, problems, rounds: rounds.map((r) => JSON.stringify(r)) }
}

/**
 * Hardware input, as a person does it: the real cursor clicks the eye button, a real Ctrl+B keypress brings the
 * windows back, then the real cursor clicks the chat button. Each step starts from a known state, so one failure
 * doesn't cascade, and records which mouse events reached the toolbar page (a dead button shows a release without
 * a press). Clicks only land while our toolbar is on screen at that spot; the cursor goes back afterwards.
 * Meant for a machine nobody is using at the time (CI): it moves the real cursor.
 */
async function hardwareSmoke(windows: WindowManager): Promise<Record<string, unknown> & { ok: boolean }> {
  if (process.platform !== "win32") return { ok: true, skipped: "Windows only" }
  const ps = (script: string) =>
    new Promise<string>((resolve) => {
      const p = spawn("powershell.exe", ["-NoProfile", "-Command", script])
      let out = ""
      p.stdout.on("data", (d) => (out += d))
      p.on("close", () => resolve(out.trim()))
    })
  const NATIVE = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e); public struct POINT { public int X; public int Y; } }';`
  const main = () => windows.get("main")!
  const where = async (title: string) => {
    if (!windows.isVisible("main")) return null
    const win = main()
    const b = win.getBounds()
    const scale = screen.getDisplayMatching(b).scaleFactor
    const r = (await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").startsWith(${JSON.stringify(title)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
    )) as { x: number; y: number } | null
    return r ? { x: Math.round((b.x + r.x) * scale), y: Math.round((b.y + r.y) * scale) } : null
  }
  const events: string[] = []
  const click = async (title: string) => {
    const p = await where(title)
    if (!p) {
      events.push(`${title}: toolbar not on screen, not clicked`)
      return false
    }
    await main().webContents.executeJavaScript(
      `window.__ev = []; if (!window.__hooked) { window.__hooked = true; for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) addEventListener(t, () => window.__ev.push(t), true) }`
    )
    await ps(`${NATIVE} [H]::SetCursorPos(${p.x}, ${p.y}) | Out-Null; Start-Sleep -Milliseconds 150; [H]::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 80; [H]::mouse_event(4, 0, 0, 0, 0)`)
    await sleep(200)
    events.push(`${title}: toolbar page got [${((await main().webContents.executeJavaScript("window.__ev")) as string[]).join(", ")}]`)
    return true
  }
  const ctrlB = () => ps(`${NATIVE} [H]::keybd_event(0x11, 0, 0, 0); Start-Sleep -Milliseconds 40; [H]::keybd_event(0x42, 0, 0, 0); Start-Sleep -Milliseconds 60; [H]::keybd_event(0x42, 0, 2, 0); [H]::keybd_event(0x11, 0, 2, 0)`)
  const saved = await ps(`${NATIVE} $p = New-Object H+POINT; [H]::GetCursorPos([ref]$p) | Out-Null; "$($p.X) $($p.Y)"`)
  const steps: string[] = []
  const problems: string[] = []
  const check = (label: string, ok: boolean) => {
    steps.push(`${ok ? "ok  " : "FAIL"} ${label}`)
    if (!ok) problems.push(label)
  }
  /** Toolbar showing, panel closed, whatever happened before. */
  const reset = async () => {
    if (!windows.isVisible("main")) windows.showAll()
    if (windows.isVisible("chat")) windows.hide("chat")
    await sleep(600)
  }
  // HW_PLAN picks what happens before the chat button is clicked, to find what breaks the toolbar:
  //   click-key  the eye button (real click), then a real Ctrl+B: what users do (default)
  //   click-api  the eye button, then shown again by code      api-key   hidden by code, then a real Ctrl+B
  //   api-api    hidden and shown by code                      move-key  real Ctrl+Down, Ctrl+Up (moves, no hiding)
  //   shift-key  a real Shift press, nothing else
  const plan = process.env.HW_PLAN || "click-key"
  const realKey = (vk: number) => ps(`${NATIVE} [H]::keybd_event(${vk}, 0, 0, 0); Start-Sleep -Milliseconds 60; [H]::keybd_event(${vk}, 0, 2, 0)`)
  const ctrlKey = (vk: number) => ps(`${NATIVE} [H]::keybd_event(0x11, 0, 0, 0); Start-Sleep -Milliseconds 40; [H]::keybd_event(${vk}, 0, 0, 0); Start-Sleep -Milliseconds 60; [H]::keybd_event(${vk}, 0, 2, 0); [H]::keybd_event(0x11, 0, 2, 0)`)
  steps.push(`plan: ${plan}`)
  try {
    await sleep(800)
    if (process.env.HW_CONTROL !== "0") {
      // Control: real clicks on the chat button before anything else happened.
      await click("Answers and chat")
      await sleep(1000)
      check("control: the chat button opens the panel", windows.isVisible("chat"))
      await click("Answers and chat")
      await sleep(1000)
      check("control: the chat button closes the panel", !windows.isVisible("chat"))
    }
    for (let round = 1; round <= Number(process.env.HW_ROUNDS || 3); round++) {
      await reset()
      if (plan === "move-key") {
        await ctrlKey(0x28)
        await sleep(400)
        await ctrlKey(0x26)
        await sleep(900)
      } else if (plan === "shift-key") {
        await realKey(0x10)
        await sleep(900)
      } else {
        if (plan.startsWith("click")) await click("Hide all windows")
        else windows.hideAll()
        await sleep(800)
        const hidden = !windows.isVisible("main")
        check(`round ${round}: everything hidden`, hidden)
        if (!hidden) windows.hideAll()
        await sleep(300)
        if (plan.endsWith("key")) await ctrlB()
        else windows.toggleAll()
        await sleep(900)
        const back = windows.isVisible("main")
        check(`round ${round}: the toolbar is back`, back)
        if (!back) windows.showAll()
        await sleep(300)
      }
      if (windows.isVisible("chat")) windows.hide("chat")
      await sleep(400)
      await click("Answers and chat")
      await sleep(1000)
      check(`round ${round}: then the chat button opens the panel`, windows.isVisible("chat"))
      if (windows.isVisible("chat")) {
        await click("Answers and chat")
        await sleep(1000)
        check(`round ${round}: and closes it again`, !windows.isVisible("chat"))
      }
    }
  } finally {
    const [x, y] = saved.split(" ").map(Number)
    if (Number.isFinite(x) && Number.isFinite(y)) await ps(`${NATIVE} [H]::SetCursorPos(${x}, ${y}) | Out-Null`)
  }
  return { ok: problems.length === 0, steps, events }
}

/**
 * The own-key flow in the real panel, against a fake OpenAI-compatible server on localhost: the tray's
 * "Use your own API key…" opens the form, it fills, Save checks the endpoint and switches the app over, and a
 * chat message is answered by that endpoint with the user's key. PNGs of each step go to IGPT_SMOKE_SHOTS.
 */
async function ownKeySmoke(windows: WindowManager, chat: ChatService, settings: SettingsStore): Promise<Record<string, unknown> & { ok: boolean }> {
  const seen: { path: string; auth?: string; model?: unknown; task?: string }[] = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, model: body.model, task: req.headers["x-meetingly-task"] as string | undefined })
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ data: [{ id: "smoke-model" }, { id: "smoke-model-mini" }] }))
      }
      const text = "**Kafka is a distributed log for streaming events.**\n- Topics split into partitions\n- Consumers read at their own pace"
      if (body.stream) {
        const chunk = (choices: object[], extra: object = {}) =>
          `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: body.model, choices, ...extra })}\n\n`
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        return res.end(chunk([{ index: 0, delta: { content: text }, finish_reason: null }]) + chunk([], { usage: { total_tokens: 9 } }) + "data: [DONE]\n\n")
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "1", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { total_tokens: 9 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const dir = process.env.IGPT_SMOKE_SHOTS
  const shot = async (name: string) => {
    const win = windows.get("chat")
    if (dir && win) fs.writeFileSync(`${dir}/ownkey-${name}.png`, (await win.webContents.capturePage()).toPNG())
  }
  const panel = windows.get("chat")
  const run = (js: string) => panel!.webContents.executeJavaScript(js) as Promise<unknown>
  const steps: Record<string, boolean> = {}
  try {
    settings.update({ ownKey: null })
    windows.showPanel("answers")
    await sleep(500)
    windows.send("chat", "plan:state", { status: "signed-out" })
    await sleep(500)
    await shot("1-signed-out")
    // Not offered on the signed-out bar any more: only the tray opens it.
    const offeredOnBar = (await run(`[...document.querySelectorAll("button")].some((x) => x.textContent.includes("OpenRouter"))`)) === true
    openOwnKeyForm(windows)
    await sleep(600)
    steps.offered = !offeredOnBar && (await run(`Boolean(document.getElementById("own-url"))`)) === true
    const fill = (id: string, value: string) =>
      run(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new FocusEvent("blur")); el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); return true })()`)
    steps.filled = (await fill("own-url", base)) === true && (await fill("own-key", "sk-smoke-123")) === true && (await fill("own-model", "smoke-model")) === true
    await sleep(800)
    steps.listedModels = (await run(`document.querySelectorAll("#own-models option").length`)) === 2
    await shot("2-form")
    await run(`document.querySelector("form button[type=submit]").click()`)
    for (let i = 0; i < 20 && !settings.get().ownKey; i++) await sleep(250)
    const saved = settings.get().ownKey
    steps.saved = Boolean(saved && saved.model === "smoke-model" && saved.baseUrl === base && saved.key && saved.key !== "sk-smoke-123")
    steps.checked = seen.some((s) => s.path === "/v1/chat/completions" && s.auth === "Bearer sk-smoke-123")
    await sleep(1200)
    steps.bar = (await run(`document.body.innerText.includes("smoke-model")`)) === true
    await shot("3-in-use")
    const before = seen.length
    const reply = new Promise<string>((resolve) => {
      const onMessage = (m: { role: string; kind?: string; text: string }) => {
        if (m.role === "assistant") {
          chat.off("message", onMessage)
          resolve(m.kind === "error" ? `error: ${m.text}` : m.text)
        }
      }
      chat.on("message", onMessage)
    })
    await chat.send("What is Kafka?")
    const text = await Promise.race([reply, sleep(20000).then(() => "timeout")])
    const answered = seen.slice(before).find((s) => s.path === "/v1/chat/completions")
    steps.answered = text.startsWith("**Kafka") && answered?.auth === "Bearer sk-smoke-123" && answered.model === "smoke-model" && answered.task === undefined
    await sleep(600)
    await shot("4-answer")
    if (dir) await ollamaShot(run, settings, windows, shot)
    return { ok: Object.values(steps).every(Boolean) && Object.keys(steps).length === 7, steps, requests: seen.map((s) => s.path) }
  } catch (err) {
    return { ok: false, steps, error: (err as Error).message }
  } finally {
    settings.update({ ownKey: null })
    server.close()
  }
}

/**
 * For the store and README images: the form as an Ollama user fills it, with the model list coming from a
 * stand-in on Ollama's own port (skipped when something already listens there). Not part of the check.
 */
async function ollamaShot(run: (js: string) => Promise<unknown>, settings: SettingsStore, windows: WindowManager, shot: (name: string) => Promise<void>): Promise<void> {
  const ollama = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(req.url === "/v1/models" ? JSON.stringify({ data: ["gpt-oss:20b", "llama3.2", "qwen3:8b"].map((id) => ({ id })) }) : "{}")
  })
  const listening = await new Promise<boolean>((resolve) => {
    ollama.once("error", () => resolve(false))
    ollama.listen(11434, "127.0.0.1", () => resolve(true))
  })
  if (!listening) return
  try {
    settings.update({ ownKey: null })
    windows.send("chat", "chat:cleared", undefined)
    windows.send("chat", "plan:state", { status: "signed-out" })
    await sleep(500)
    openOwnKeyForm(windows)
    await sleep(600)
    await run(`[...document.querySelectorAll("form button")].find((b) => b.textContent === "Ollama")?.click()`)
    await sleep(800)
    await run(`(() => { const el = document.getElementById("own-model");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "llama3.2");
      el.dispatchEvent(new Event("input", { bubbles: true })) })()`)
    await sleep(400)
    await shot("5-ollama")
  } finally {
    ollama.close()
  }
}

/**
 * Frames for the README demo: the panel during an interview, an answer streaming in after each question.
 * Writes demo-NNN.png (panel) + demo-main.png (toolbar) with their bounds into IGPT_SMOKE_SHOTS, plus
 * frames.json with each frame's duration; scripts outside the app turn them into an animation.
 */
async function demoFrames(windows: WindowManager, dir: string): Promise<void> {
  const now = Date.now()
  const frames: { file: string; ms: number }[] = []
  const panel = () => windows.get("chat")!
  const grab = async (ms: number) => {
    const file = `demo-${String(frames.length).padStart(3, "0")}.png`
    fs.writeFileSync(`${dir}/${file}`, (await panel().webContents.capturePage()).toPNG())
    frames.push({ file, ms })
  }
  windows.setPanelExtra(SUGGESTIONS_WIDTH)
  windows.showPanel("answers")
  await sleep(1500)
  windows.send("chat", "chat:cleared", undefined)
  windows.send("chat", "session:state", { status: "paused", startedAt: now, notice: null, connected: true, audioSource: "both", audioDeviceId: "" })
  // The toolbar shows a call in progress; only the panel captures audio, and it stays paused.
  windows.send("main", "session:state", { status: "recording", startedAt: now - 754_000, notice: null, connected: true, audioSource: "both", audioDeviceId: "" })
  const scenes = [
    {
      topic: "Scaling the payments database",
      suggestions: ["How do you choose a shard key?", "Replication vs sharding: what's the difference?", "What would you do if latency doubled overnight?"],
      question: "How would you scale the database as traffic grows?",
      answer: "**I'd scale it in stages: find the bottleneck, fix queries and indexes, then add read replicas and shard by key.**\n- Profile the load first\n- Indexes and query plans\n- Read replicas for reads\n- Shard by merchant ID"
    },
    {
      topic: "Scaling the payments database",
      suggestions: ["How do you keep shards balanced?", "How would you migrate without downtime?", "What metrics would you alert on?"],
      question: "And what would you do first if latency doubled overnight?",
      answer: "**First I'd check what changed: deploys, traffic and slow queries, then roll back if a release lines up.**\n- Compare p95 before and after\n- Slow-query log and lock waits\n- Roll back, then dig in"
    }
  ]
  await grab(700)
  for (const [i, scene] of scenes.entries()) {
    windows.send("chat", "suggestions:state", { topic: scene.topic, items: scene.suggestions.map((text, n) => ({ id: `q${i}${n}`, text })), updating: false })
    windows.send("chat", "chat:message", { id: `u${i}`, role: "user", kind: "auto", text: scene.question, timestamp: now })
    windows.send("chat", "chat:busy", true)
    await sleep(250)
    await grab(500)
    const id = `a${i}`
    const words = scene.answer.split(/(?<= )/)
    for (let w = 0; w < words.length; w += 2) {
      windows.send("chat", "chat:chunk", { id, text: words.slice(w, w + 2).join("") })
      await sleep(60)
      await grab(70)
    }
    windows.send("chat", "chat:message", { id, role: "assistant", kind: "auto", text: scene.answer, timestamp: now })
    windows.send("chat", "chat:busy", false)
    await sleep(250)
    await grab(i === scenes.length - 1 ? 3200 : 2400)
  }
  const main = windows.get("main")
  if (main) fs.writeFileSync(`${dir}/demo-main.png`, (await main.webContents.capturePage()).toPNG())
  fs.writeFileSync(`${dir}/frames.json`, JSON.stringify({ frames, chat: panel().getBounds(), main: main?.getBounds() }, null, 1))
}

/** Real model round-trips through ChatService.autoAnswer (relay, current default prompt). */
async function answersSmoke(chat: ChatService, settings: SettingsStore): Promise<Record<string, unknown> & { ok: boolean }> {
  const cases: { lang: "en" | "ru"; text: string; expect: "answer" | "skip" }[] = [
    { lang: "en", text: "What is Kafka?", expect: "answer" },
    { lang: "en", text: "So how would you design a rate limiter for a public API", expect: "answer" },
    { lang: "en", text: "Tell me about a time you disagreed with your manager.", expect: "answer" },
    { lang: "en", text: "Thanks, that makes sense, let's move on to the next part.", expect: "skip" },
    { lang: "ru", text: "Что такое Kafka?", expect: "answer" },
    { lang: "ru", text: "Расскажите, как бы вы масштабировали базу данных.", expect: "answer" },
    { lang: "ru", text: "Хорошо, понятно, спасибо.", expect: "skip" }
  ]
  const original = settings.get()
  const results: Record<string, unknown>[] = []
  for (const c of cases) {
    settings.update({ autoAnswer: "questions", outputLanguage: c.lang, audioLanguage: c.lang })
    chat.clear()
    let answer: string | null = null
    const onAnswer = (m: { text: string }) => { answer = m.text }
    chat.on("auto-answer", onAnswer)
    const started = Date.now()
    await chat.autoAnswer({ text: c.text, speaker: null, timestamp: Date.now() })
    chat.off("auto-answer", onAnswer)
    const got = answer === null ? "skip" : "answer"
    results.push({ heard: c.text, expect: c.expect, got, ok: got === c.expect, ms: Date.now() - started, answer })
  }
  settings.update({ autoAnswer: original.autoAnswer, outputLanguage: original.outputLanguage, audioLanguage: original.audioLanguage })
  return { ok: results.every((r) => r.ok), results }
}

/** Read a 16 kHz mono WAV (16-bit PCM or 32-bit float) as signed 16-bit samples. */
function readWav16k(file: string): Int16Array {
  const buf = fs.readFileSync(file)
  let off = 12
  let format = 1
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === "fmt ") format = buf.readUInt16LE(off + 8)
    if (id === "data") {
      const data = buf.subarray(off + 8, off + 8 + size)
      if (format === 3) {
        const f = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~3)))
        return Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))))
      }
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)))
    }
    off += 8 + size + (size % 2)
  }
  throw new Error("no audio data in " + file)
}

/** Feed a recording through the speech worker at real-time pace (100 ms chunks), plus 1.5 s of silence. */
async function asrSmoke(model: AsrModel, wav: string, language: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const started = Date.now()
  const socket = new LocalAsrSocket({ language, model })
  const finals: { text: string; speechFinal: boolean; channel: unknown; atMs: number }[] = []
  let partials = 0
  const workerErrors: string[] = []
  socket.on("error", (e: Error) => workerErrors.push(e.message))
  let firstPartialMs: number | null = null
  socket.on("transcript", (e: { text: string; isFinal: boolean; speechFinal: boolean; channel?: unknown }) => {
    if (e.isFinal) finals.push({ text: e.text, speechFinal: e.speechFinal, channel: e.channel, atMs: Date.now() - started })
    else {
      partials++
      if (firstPartialMs === null) firstPartialMs = Date.now() - started
    }
  })
  try {
    await socket.connect()
    const readyMs = Date.now() - started
    const pcm = readWav16k(wav)
    // Stereo like the capture: the recording plays on the system-audio side ("them"), the mic is silent.
    const side = process.env.IGPT_SMOKE_SIDE === "you" ? 0 : 1
    const frames = pcm.length + 24000
    const stereo = new Int16Array(frames * 2)
    for (let i = 0; i < pcm.length; i++) stereo[2 * i + side] = pcm[i]
    const feedStart = Date.now()
    for (let f = 0; f < frames; f += 1600) {
      socket.sendAudio(stereo.slice(2 * f, 2 * Math.min(frames, f + 1600)).buffer)
      await sleep(100)
    }
    await sleep(1500)
    socket.close()
    await sleep(800)
    return {
      ok: finals.length > 0,
      readyMs,
      audioSeconds: +(pcm.length / 16000).toFixed(1),
      firstPartialMs: firstPartialMs === null ? null : firstPartialMs - (feedStart - started),
      partials,
      finals,
      workerErrors
    }
  } catch (err) {
    socket.close()
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Account linking and two-way sync against a real server. Needs:
 *   IGPT_CLOUD_URL          the account service base URL (an ssh tunnel to a test copy works)
 *   IGPT_SMOKE_USER/_PASS   an existing, verified account that plays the browser side
 * A second, scripted "computer" is linked to the same account to make changes this app must receive.
 * Ends with both devices unlinked again.
 */
async function cloudSmoke({ cloud, settings, meetings }: Pick<SmokeDeps, "cloud" | "settings" | "meetings">): Promise<Record<string, unknown> & { ok: boolean }> {
  const base = (process.env.IGPT_CLOUD_URL ?? "").replace(/\/+$/, "")
  const email = process.env.IGPT_SMOKE_USER
  const password = process.env.IGPT_SMOKE_PASS
  const steps: Record<string, unknown> = {}
  const fail = (step: string, detail: unknown) => ({ ok: false, failedAt: step, detail, steps })
  if (!base || !email || !password) return fail("env", "IGPT_CLOUD_URL, IGPT_SMOKE_USER and IGPT_SMOKE_PASS are required")

  const call = async (method: string, path: string, opts: { body?: unknown; token?: string; cookie?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    return { body, res }
  }
  const waitFor = async (what: string, check: () => boolean | Promise<boolean>, ms = 15000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return true
      await sleep(300)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  let otherToken = ""
  try {
    // Seed one local meeting so the upload path is exercised.
    const smokeMeetingId = `smoke_${Date.now()}`
    meetings.save({
      id: smokeMeetingId,
      title: "Smoke meeting",
      startTime: Date.now() - 60000,
      endTime: Date.now(),
      duration: 60000,
      transcript: [{ text: "hello from the smoke test", timestamp: Date.now(), confidence: 1, speaker: 0 }],
      fullTranscriptText: "hello from the smoke test",
      language: "en",
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    if (settings.get().cloud) await cloud.unlink()

    // 1. app side: start linking (no browser is opened in smoke mode)
    const started = await cloud.linkStart()
    steps.code = started.code
    if (!started.code) return fail("link-start", started)

    // 2. browser side: sign in and confirm the code
    const signIn = await call("POST", "/api/auth/sign-in", { body: { email, password } })
    const cookie = (signIn.res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("session=")) ?? ""
    if (!cookie) return fail("sign-in", "no session cookie")
    await call("POST", "/api/app/link/claim", { cookie, body: { code: started.code } })

    // 3. app side: the poll picks the token up and goes online
    await waitFor("cloud online", () => cloud.state().status === "online", 20000)
    steps.linkedAs = cloud.state().email

    // 4. a second computer on the same account, scripted
    const otherId = `smoke${Date.now().toString(36)}other`
    const other = await call("POST", "/api/app/link/start", { body: { deviceId: otherId, name: "Smoke second computer", platform: "linux", appVersion: "smoke" } })
    await call("POST", "/api/app/link/claim", { cookie, body: { code: other.body.code } })
    otherToken = (await call("GET", `/api/app/link/poll?code=${other.body.code}&deviceId=${otherId}`)).body.token
    if (!otherToken) return fail("second-device", "no token")

    // 5. the account has this app's profile, prompts and meeting
    const profile = (await call("GET", "/api/app/profile", { token: otherToken })).body.profile
    const prompts = (await call("GET", "/api/app/prompts", { token: otherToken })).body.prompts as { id: string; title: string; content: string; notes: string; active: boolean }[]
    await waitFor("meeting upload", async () => (await call("GET", "/api/app/meetings", { token: otherToken })).body.index.some((m: { localId: string }) => m.localId === smokeMeetingId))
    steps.initialUpload = { profile: Boolean(profile), prompts: prompts.length, meeting: "ok" }
    if (!profile || prompts.length < 1) return fail("initial-upload", steps)

    // 6. other computer -> this app (live): a setting
    const before = settings.get().answerLength
    const target = before === "short" ? "medium" : "short"
    await call("PUT", "/api/app/profile", { token: otherToken, body: { settings: { ...profile.settings, answerLength: target } } })
    await waitFor("remote setting to arrive", () => settings.get().answerLength === target)
    steps.remoteToLocal = "ok"

    // 7. this app -> the account: a setting
    const lang = settings.get().outputLanguage === "fr" ? "de" : "fr"
    settings.update({ outputLanguage: lang })
    await waitFor("local setting to upload", async () => (await call("GET", "/api/app/profile", { token: otherToken })).body.profile?.settings?.outputLanguage === lang)
    steps.localToRemote = "ok"

    // 8. a prompt edited on the other computer shows up here
    await call("PUT", "/api/app/prompts", { token: otherToken, body: { prompts: prompts.map((p, i) => ({ ...p, notes: i === 0 ? "smoke background note" : p.notes })) } })
    await waitFor("remote prompt edit", () => settings.get().prompts.some((p) => p.notes === "smoke background note"))
    steps.promptSync = "ok"

    // 9. the meeting deleted on the other computer disappears here
    await call("DELETE", `/api/app/meetings/${smokeMeetingId}`, { token: otherToken })
    await waitFor("remote meeting delete", () => !meetings.get(smokeMeetingId))
    steps.meetingDelete = "ok"

    // 10. clean up: restore, unlink both
    settings.update({ answerLength: before, outputLanguage: "en" })
    await sleep(1500)
    await call("DELETE", "/api/app/device", { token: otherToken })
    otherToken = ""
    await cloud.unlink()
    steps.unlinked = cloud.state().status
    return { ok: cloud.state().status === "off", steps }
  } catch (err) {
    if (otherToken) await call("DELETE", "/api/app/device", { token: otherToken }).catch(() => undefined)
    return fail("exception", (err as Error).message)
  }
}

/** Windows text-to-speech through the default speakers; resolves false where unavailable. */
function speakOnWindows(text: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false)
  return new Promise((resolve) => {
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume = 100; $s.Speak('${text.replace(/'/g, "''")}')`
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true })
    child.on("error", () => resolve(false))
    child.on("exit", (code) => resolve(code === 0))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
