import React from "react"
import ReactDOM from "react-dom/client"
import "@fontsource-variable/inter/opsz.css"
import "./index.css"
import type { WindowKind } from "@shared/types"
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
