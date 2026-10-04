import React from "react"
import ReactDOM from "react-dom/client"
import "@fontsource-variable/inter/opsz.css"
import "./index.css"
import type { WindowKind } from "@shared/types"
import { setLocale } from "@shared/i18n"
import { useSettings } from "@/lib/hooks"
import { MainWindow } from "./windows/MainWindow"
import { PanelWindow } from "./windows/PanelWindow"
import { DashboardWindow } from "./windows/DashboardWindow"

const WINDOWS: Record<WindowKind, React.FC> = {
  main: MainWindow,
  chat: PanelWindow,
  dashboard: DashboardWindow
}

function currentKind(): WindowKind {
  const kind = window.location.hash.replace(/^#\/?/, "") as WindowKind
  return kind in WINDOWS ? kind : "main"
}

const kind = currentKind()
document.body.dataset.window = kind
const Root = WINDOWS[kind]

/** Waits for the interface language, then renders; a language change remounts the window in it. */
function LocaleRoot() {
  const [settings] = useSettings()
  if (!settings) return null
  setLocale(settings.uiLocale)
  document.documentElement.lang = settings.uiLocale
  return <Root key={settings.uiLocale} />
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleRoot />
  </React.StrictMode>
)
