import * as React from "react"
import { cva as tv, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const toggle = tv("inline-flex items-center justify-center rounded-md text-sm", {
  variants: {
    variant: {
      solid: "bg-primary text-primary-foreground",
      quiet: "bg-transparent text-foreground/80",
    },
    size: {
      sm: "h-7 px-2",
      md: "h-8 px-3",
    },
  },
  defaultVariants: { variant: "solid", size: "md" },
})

const toggleLabelVariants = tv("px-1", {
  variants: {
    tone: {
      muted: "text-muted-foreground",
      strong: "text-foreground",
    },
  },
  defaultVariants: { tone: "muted" },
})

type ToggleProps = React.ComponentProps<"button"> &
  VariantProps<typeof toggle> & { pressed?: boolean }

function Toggle({ className, variant, size, pressed = false, ...props }: ToggleProps) {
  return (
    <button
      data-slot="toggle"
      aria-pressed={pressed}
      className={cn(toggle({ variant, size, className }))}
      {...props}
    />
  )
}

function ToggleLabel({ className, tone, ...props }:
  React.ComponentProps<"span"> & VariantProps<typeof toggleLabelVariants>) {
  return <span className={cn(toggleLabelVariants({ tone, className }))} {...props} />
}

export { Toggle, ToggleLabel, toggle, toggleLabelVariants }
