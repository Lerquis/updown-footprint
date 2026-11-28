"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Selector de pastillas (una opcion activa), estilo "Semana | Mes". */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "sm",
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  size?: "xs" | "sm";
  /** nombre accesible del grupo */
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full border bg-muted/60 p-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5",
              size === "xs" ? "h-6 px-2.5 text-[11px]" : "h-7 px-3 text-xs",
              on ? "bg-card text-foreground shadow-xs ring-1 ring-foreground/10" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
