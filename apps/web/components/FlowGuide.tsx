"use client";

import { CircleQuestionMark } from "lucide-react";
import { SCENARIOS, type SignalType } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BIAS_LABEL, SIGNAL_INFO, biasText } from "@/lib/flow";
import { cn } from "@/lib/utils";

const GROUPS: { title: string; test: (id: string) => boolean }[] = [
  { title: "Precio × CVD (qué hacen el precio y el flujo)", test: (id) => /^(up|down|flat)-|^balance$|-confirmed$/.test(id) && !id.includes("exhaustion") && !id.startsWith("stacked") },
  { title: "Agotamiento", test: (id) => id.startsWith("exhaustion") },
  { title: "Absorción", test: (id) => id.startsWith("absorption") },
  { title: "Desequilibrios apilados", test: (id) => id.startsWith("stacked") },
  { title: "Divergencias de CVD", test: (id) => id.startsWith("cvd-div") },
  { title: "Combinaciones", test: (id) => id.startsWith("confluence") || id === "mixed" },
];

const SIGNALS: SignalType[] = ["stackedImbalance", "absorption", "exhaustion", "cvdDivergence"];

/** Botón "?" → modal con conceptos, señales y el catálogo completo de escenarios del monitor. */
export function FlowGuide() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Guía de señales y escenarios" />}>
        <CircleQuestionMark />
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Guía de señales y escenarios</DialogTitle>
          <DialogDescription>
            El monitor combina el footprint, el CVD y el movimiento del precio para interpretar qué está pasando. Es una
            lectura automática del flujo de órdenes, no una recomendación de inversión.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <section className="space-y-1">
            <h3 className="font-semibold">Conceptos</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                <b className="text-foreground">Compra/venta agresiva:</b> quien cruza el spread y ejecuta al instante. Una compra
                agresiva golpea el <i>ask</i>; una venta agresiva golpea el <i>bid</i>.
              </li>
              <li>
                <b className="text-foreground">Footprint:</b> cada barra de 1 minuto con el volumen vendedor (bid) y comprador (ask)
                en cada nivel de precio.
              </li>
              <li>
                <b className="text-foreground">Delta:</b> volumen comprador agresivo − vendedor agresivo. <b className="text-foreground">CVD:</b>{" "}
                el delta acumulado (empieza en 0 al inicio de la memoria del servidor): si sube, mandan las compras agresivas.
              </li>
              <li>
                <b className="text-foreground">Tendencias:</b> el monitor compara precio y CVD en los últimos 5 minutos y las clasifica
                como sube / baja / plano.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">Señales que se marcan en la gráfica</h3>
            <p className="text-muted-foreground">
              Se detectan al cerrar cada barra. <b className="text-buy">▲ verde</b> = implicación alcista,{" "}
              <b className="text-sell">▼ roja</b> = implicación bajista.
            </p>
            {SIGNALS.map((t) => (
              <div key={t} className="rounded-md border p-2">
                <div className="font-medium">
                  {SIGNAL_INFO[t].label} <span className="font-mono text-xs text-muted-foreground">({SIGNAL_INFO[t].short})</span>
                </div>
                <p className="text-muted-foreground">{SIGNAL_INFO[t].desc}</p>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <h3 className="font-semibold">Todos los escenarios que evalúa el monitor</h3>
            {GROUPS.map((g) => {
              const items = SCENARIOS.filter((s) => g.test(s.id));
              if (!items.length) return null;
              return (
                <div key={g.title} className="space-y-1.5">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h4>
                  {items.map((s) => (
                    <div key={s.id} className="rounded-md border p-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.title}</span>
                        <Badge variant="outline" className={cn("h-4 px-1.5 text-[10px]", biasText(s.bias))}>
                          {BIAS_LABEL[s.bias]}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <b className="text-foreground">Cuando:</b> {s.when}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.meaning}</p>
                    </div>
                  ))}
                </div>
              );
            })}
          </section>

          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            Límites: son reglas heurísticas sobre datos de Binance spot; ninguna señal garantiza un resultado. Los umbrales
            (ratio 3:1, 3 niveles apilados, etc.) son configurables en el servidor. Úsalo como apoyo a la lectura del mercado.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
