import * as React from "react"
import { cn } from "@/lib/utils"

const fieldClass =
  "w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 " +
  "focus:border-white/40 focus:outline-none disabled:opacity-50"

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldClass, "h-9", className)} {...props} />
))
Input.displayName = "Input"

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(fieldClass, "min-h-[96px] resize-y leading-relaxed", className)} {...props} />
)
Textarea.displayName = "Textarea"

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(fieldClass, "h-9 cursor-pointer bg-black/60", className)} {...props} />
))
Select.displayName = "Select"

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label?: string
}

export function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40",
        checked ? "border-sky-400/50 bg-sky-500/80" : "border-white/20 bg-white/10"
      )}
    >
      <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-6" : "translate-x-1")} />
    </button>
  )
}

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
  inline?: boolean
}

/** Label + description + control, stacked or side by side. */
export function Field({ label, hint, children, inline }: FieldProps) {
  return (
    <div className={cn("rounded-lg border border-white/10 bg-white/5 p-4", inline && "flex items-center justify-between gap-4")}>
      <div className={cn(!inline && "mb-3")}>
        <div className="text-sm font-medium text-white">{label}</div>
        {hint && <p className="mt-0.5 text-xs text-white/55">{hint}</p>}
      </div>
      <div className={cn(inline && "shrink-0")}>{children}</div>
    </div>
  )
}
