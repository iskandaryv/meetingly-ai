import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", {
  variants: {
    variant: {
      neutral: "border-white/15 bg-white/10 text-white/80",
      success: "border-emerald-400/30 bg-emerald-500/15 text-emerald-300",
      warning: "border-amber-400/30 bg-amber-500/15 text-amber-300",
      danger: "border-rose-400/30 bg-rose-500/15 text-rose-300",
      info: "border-sky-400/30 bg-sky-500/15 text-sky-300"
    }
  },
  defaultVariants: { variant: "neutral" }
})

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

/** Pulsing dot used for live indicators. */
export function Dot({ className }: { className?: string }) {
  return <span className={cn("inline-block h-2 w-2 rounded-full", className)} />
}
