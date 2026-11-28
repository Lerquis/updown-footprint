"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Segmented } from "./Segmented";

const NAV = [
  { href: "/", label: "Panel", id: "panel" },
  { href: "/compare", label: "Spot vs futures", id: "compare" },
] as const;

/** Barra superior comun: marca, navegacion en pastillas, controles propios de la pagina (`children`) y tema claro/oscuro. */
export function AppHeader({ active, children }: { active: (typeof NAV)[number]["id"] | null; children?: ReactNode }) {
  const [theme, setTheme] = useTheme();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1680px] items-center gap-3 px-3 sm:gap-5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Updown Footprint">
          <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground">
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              <path d="M2 11.5l3.5-4 3 2.5L14 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="hidden text-[15px] font-bold tracking-tight md:inline">Updown Footprint</span>
        </Link>
        <nav className="flex items-center gap-0.5 rounded-full border bg-card p-0.5" aria-label="Páginas">
          {NAV.map((n) => (
            <Link
              key={n.id}
              href={n.href}
              aria-current={active === n.id ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors sm:px-4",
                active === n.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {children}
          <Segmented
            label="Tema"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: <Sun aria-label="Claro" />, title: "Tema claro" },
              { value: "dark", label: <Moon aria-label="Oscuro" />, title: "Tema oscuro" },
            ]}
          />
        </div>
      </div>
    </header>
  );
}
