import { useMemo } from "react"
import { renderMarkdown } from "@/lib/markdown"
import { cn } from "@/lib/utils"

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={cn("md selectable text-[13px] leading-relaxed text-white/90", className)} dangerouslySetInnerHTML={{ __html: html }} />
}
