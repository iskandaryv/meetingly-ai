import type { ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "./ui/button"
import { cn } from "@/lib/utils"

interface PanelProps {
  title: ReactNode
  /** Extra header content (badges, tabs). */
  aside?: ReactNode
  onClose?: () => void
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** Opaque, square: for windows that have their own OS frame. */
  solid?: boolean
}

/** Standard glass window: header with title and close, scrollable body. */
export function Panel({ title, aside, onClose, children, className, bodyClassName, solid }: PanelProps) {
  return (
    <div className={cn(solid ? "flex h-full w-full flex-col overflow-hidden bg-[#141416]" : "glass flex h-full w-full flex-col overflow-hidden", className)}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-white">{title}</div>
        <div className="flex items-center gap-2">
          {aside}
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </header>
      <div className={cn("scroll min-h-0 flex-1", bodyClassName)}>{children}</div>
    </div>
  )
}
