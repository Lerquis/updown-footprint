import { BUY_GRADIENT, SELL_GRADIENT } from "@/lib/heatmapPalette";

function Scale({ gradient, title, hint }: { gradient: string; title: string; hint: string }) {
  return (
    <div className="flex items-center gap-2">
      <div>
        <div className="text-xs font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="h-2.5 w-28 rounded-full" style={{ background: gradient }} />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>poca</span>
          <span>mucha</span>
        </div>
      </div>
    </div>
  );
}

/** Leyenda del heatmap: que significa cada color y cuando una zona es "caliente". */
export function HeatmapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b px-4 py-2.5 sm:px-5">
      <Scale gradient={BUY_GRADIENT} title="Zona de compra" hint="órdenes de compra esperando (debajo del precio)" />
      <Scale gradient={SELL_GRADIENT} title="Zona de venta" hint="órdenes de venta esperando (encima del precio)" />
      <span className="text-[11px] text-muted-foreground">
        Color casi blanco = <b className="text-foreground">zona caliente</b>: una pared de órdenes muy grande.
      </span>
    </div>
  );
}
