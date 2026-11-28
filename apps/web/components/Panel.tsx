"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useStored } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPEN = ["open", "closed"] as const;

/**
 * Tarjeta plegable (acordeon) de la pagina. El estado abierto/cerrado se recuerda por `id` en el navegador.
 * Plegada, su contenido se desmonta (los canvas dejan de dibujar), pero los datos siguen llegando: los hooks viven en el padre.
 * El contenido es un contenedor (`@container`): los hijos se adaptan al ancho de la tarjeta, no al de la ventana.
 */
export function Panel({
  id,
  title,
  titleExtra,
  description,
  actions,
  toolbar,
  defaultOpen = true,
  children,
  className,
  contentClassName,
}: {
  /** clave del estado recordado (unica en la pagina) */
  id: string;
  title: ReactNode;
  /** junto al titulo, fuera del boton de plegar (p. ej. un boton de ayuda) */
  titleExtra?: ReactNode;
  description?: ReactNode;
  /** a la derecha de la cabecera; visibles tambien con la tarjeta plegada (estados en vivo) */
  actions?: ReactNode;
  /** controles bajo la cabecera, solo con la tarjeta abierta */
  toolbar?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const [state, setState] = useStored(`updown.panel.${id}`, defaultOpen ? "open" : "closed", OPEN);
  const open = state === "open";
  const toggle = () => setState(open ? "closed" : "open");
  const bodyId = useId();
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs", className)}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            title={open ? "Plegar" : "Desplegar"}
            className="mt-px grid size-7 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ChevronDown className={cn("size-4 transition-transform duration-200", !open && "-rotate-90")} />
          </button>
          <div className="min-w-0">
            <div className="flex min-h-7 items-center gap-1">
              <button type="button" onClick={toggle} tabIndex={-1} className="text-left text-[15px] leading-tight font-semibold tracking-tight outline-none">
                {title}
              </button>
              {titleExtra}
            </div>
            {open && description && <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {open && (
        <div id={bodyId} className="@container animate-in border-t duration-200 fade-in-0 slide-in-from-top-1">
          {toolbar && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/40 px-4 py-2.5 sm:px-5">{toolbar}</div>}
          <div className={contentClassName}>{children}</div>
        </div>
      )}
    </section>
  );
}
