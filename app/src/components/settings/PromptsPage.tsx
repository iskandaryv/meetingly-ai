import { useState } from "react"
import { Check, Pencil, Plus, Trash2 } from "lucide-react"
import { DEFAULT_SYSTEM_PROMPT, type Prompt } from "@shared/types"
import { t } from "@shared/i18n"
import { useSettings } from "@/lib/hooks"
import { truncate } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/fields"

export function PromptsPage() {
  const [settings, update] = useSettings()
  const [editing, setEditing] = useState<Prompt | null>(null)
  if (!settings) return <p className="py-8 text-center text-xs text-white/50">{t("Loading…")}</p>

  const { prompts, activePromptId } = settings

  const save = (prompt: Prompt) => {
    const exists = prompts.some((p) => p.id === prompt.id)
    const next = exists ? prompts.map((p) => (p.id === prompt.id ? prompt : p)) : [...prompts, prompt]
    void update({ prompts: next, activePromptId: exists ? activePromptId : prompt.id })
    setEditing(null)
  }
  const remove = (id: string) => {
    if (prompts.length === 1) return
    const next = prompts.filter((p) => p.id !== id)
    void update({ prompts: next, activePromptId: activePromptId === id ? next[0].id : activePromptId })
  }

  if (editing) {
    return (
      <PromptEditor
        prompt={editing}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t("System prompts")}</h2>
          <p className="text-xs text-white/55">{t("The active prompt shapes every chat reply and screen analysis.")}</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing({ id: `p_${Date.now().toString(36)}`, title: "", content: DEFAULT_SYSTEM_PROMPT })}>
          <Plus className="h-3.5 w-3.5" /> {t("New")}
        </Button>
      </div>
      <ul className="space-y-2">
        {prompts.map((p) => {
          const active = p.id === activePromptId
          return (
            <li key={p.id} className={cn("rounded-lg border p-3", active ? "border-emerald-400/30 bg-emerald-500/10" : "border-white/10 bg-white/5")}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">{p.title || t("Untitled")}</span>
                  {active && <Badge variant="success">{t("Active")}</Badge>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!active && (
                    <Button variant="ghost" size="sm" onClick={() => update({ activePromptId: p.id })} title={t("Use this prompt")}>
                      <Check className="h-3.5 w-3.5" /> {t("Use")}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(p)} title={t("Edit")}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon-sm" className="text-rose-300/80 hover:text-rose-300" onClick={() => remove(p.id)} disabled={prompts.length === 1} title={t("Delete")}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-white/60">{truncate(p.content, 160)}</p>
              {p.notes && <p className="mt-1 text-[11px] text-emerald-300/70">{t("Background: {notes}", { notes: truncate(p.notes, 80) })}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PromptEditor({ prompt, onCancel, onSave }: { prompt: Prompt; onCancel: () => void; onSave: (p: Prompt) => void }) {
  const [title, setTitle] = useState(prompt.title)
  const [content, setContent] = useState(prompt.content)
  const [notes, setNotes] = useState(prompt.notes ?? "")
  const valid = title.trim().length > 0 && content.trim().length > 0
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{prompt.title ? t("Edit prompt") : t("New prompt")}</h2>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Title")} autoFocus />
      <div>
        <label className="mb-1 block text-xs text-white/60">{t("Instructions (how the assistant behaves)")}</label>
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder={t("System prompt")} className="min-h-[180px] font-mono text-xs" />
      </div>
      <div>
        <label className="mb-1 block text-xs text-white/60">{t("Background (what the assistant should know about you)")}</label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("Paste your CV, the job description, the product you sell, names of the people in the call… The assistant uses this in every answer.")}
          className="min-h-[160px] text-xs"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t("Cancel")}</Button>
        <Button variant="primary" disabled={!valid} onClick={() => onSave({ ...prompt, title: title.trim(), content: content.trim(), notes: notes.trim() })}>{t("Save")}</Button>
      </div>
    </div>
  )
}
