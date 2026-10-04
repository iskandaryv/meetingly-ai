import { useState } from "react"
import { Activity, Command, Settings as SettingsIcon } from "lucide-react"
import { t } from "@shared/i18n"
import { cn } from "@/lib/utils"
import { Panel } from "@/components/Panel"
import { MeetingsPage } from "@/components/meetings/MeetingsPage"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { PromptsPage } from "@/components/settings/PromptsPage"

type Page = "meetings" | "settings" | "prompts"

const PAGES: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: "meetings", label: "Meetings", icon: <Activity className="h-3.5 w-3.5" /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon className="h-3.5 w-3.5" /> },
  { id: "prompts", label: "Prompts", icon: <Command className="h-3.5 w-3.5" /> }
]

export function DashboardWindow() {
  const [page, setPage] = useState<Page>("meetings")
  return (
    <div className="h-screen w-full bg-[#141416]">
      <Panel
        solid
        title={
          <nav className="flex items-center gap-1">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPage(p.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  page === p.id ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"
                )}
              >
                {p.icon}
                {t(p.label)}
              </button>
            ))}
          </nav>
        }
        bodyClassName="mx-auto w-full max-w-3xl p-4"
      >
        {page === "meetings" && <MeetingsPage />}
        {page === "settings" && <SettingsPage />}
        {page === "prompts" && <PromptsPage />}
      </Panel>
    </div>
  )
}
