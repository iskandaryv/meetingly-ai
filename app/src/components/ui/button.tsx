import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "bg-white text-black hover:bg-white/90",
        primary: "bg-sky-500/90 text-white hover:bg-sky-400/90",
        secondary: "bg-white/15 text-white hover:bg-white/25",
        ghost: "text-white/80 hover:bg-white/10 hover:text-white",
        outline: "border border-white/20 bg-white/5 text-white hover:bg-white/10",
        danger: "bg-rose-500/80 text-white hover:bg-rose-500",
        success: "bg-emerald-500/80 text-white hover:bg-emerald-500"
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-sm",
        lg: "h-10 px-4 text-sm",
        icon: "h-8 w-8",
        "icon-sm": "h-7 w-7"
      }
    },
    defaultVariants: { variant: "secondary", size: "md" }
  }
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
))
Button.displayName = "Button"
