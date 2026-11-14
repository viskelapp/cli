import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Cards don't carry borders or shadows. Structure comes from spacing.
// variant="stat" is a summary cell: sits in a hairline-separated grid (see StatGrid).
// variant="sheet" is paper: the one place a border + mat is used (invoice preview).
const cardVariants = cva("flex flex-col text-card-foreground", {
  variants: {
    variant: {
      plain: "gap-4",
      stat: "bg-card px-3.5 py-3 gap-0.5",
      sheet: "bg-card rounded-[4px] border border-border-strong outline-[12px] outline-mat px-11 py-10 gap-6",
    },
  },
  defaultVariants: { variant: "plain" },
})

function Card({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" data-variant={variant} className={cn(cardVariants({ variant }), className)} {...props} />
}
// Grid of stat cards separated by 1px hairlines, rounded as a group.
function StatGrid({ className, label, ...props }: React.ComponentProps<"div"> & { label: string; caption?: string }) {
  return <div data-slot="stat-grid" aria-label={label} className={cn("grid gap-px bg-border rounded-lg overflow-hidden grid-cols-[repeat(auto-fit,minmax(190px,1fr))]", className)} {...props} />
}
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />
}
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("text-base font-medium leading-tight", className)} {...props} />
}
function CardLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-label" className={cn("text-xs text-muted-foreground", className)} {...props} />
}
function CardValue({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-value" className={cn("text-2xl font-normal tnum tracking-[-0.02em] mt-1", className)} {...props} />
}
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
}
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("", className)} {...props} />
}
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center", className)} {...props} />
}

export { Card, StatGrid, CardHeader, CardFooter, CardTitle, CardLabel, CardValue, CardDescription, CardContent, cardVariants }
