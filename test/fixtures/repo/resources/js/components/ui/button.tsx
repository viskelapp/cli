import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

// Pills are reserved for buttons. Nothing else in the system is fully rounded.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // One per view.
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        // Secondary actions: hairline, no shadow.
        outline: "border border-border-strong bg-background hover:bg-accent",
        // Tertiary / row actions.
        ghost: "text-foreground/80 hover:bg-accent hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-foreground underline-offset-4 hover:underline rounded-none",
      },
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-3",
        xs: "h-6 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 px-3 text-sm",
        lg: "h-9 px-4",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function Button({ className, variant = "default", size = "default", asChild = false, ...props }:
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
