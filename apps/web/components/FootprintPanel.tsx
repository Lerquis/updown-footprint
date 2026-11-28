"use client";

import { useState } from "react";
import type { FootprintBar, OrderflowSignal } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SIGNAL_INFO, biasArrow, biasText, fmtClockHM } from "@/lib/flow";
import { cn } from "@/lib/utils";
import { useAsset } from "@/lib/source";
import { Panel } from "./Panel";

const fmtVol = (v: number) => (v === 0 ? "·" : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
/** precio de un nivel sin restos de coma flotante (ETH va en pasos de 0.05) */
const fmtLevel = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(2));
const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

/** Escalera del footprint de una barra: bid | precio | ask, con desequilibrios y POC resaltados. */
function Ladder({ bar, signals }: { bar: FootprintBar; signals: OrderflowSignal[] }) {
  const rows = [...bar.levels].reverse(); // precio alto arriba
  const maxVol = Math.max(...bar.levels.map((l) => Math.max(l[1], l[2])), 1e-9);
  const poc = bar.levels.reduce((a, l) => (l[1] + l[2] > a[1] + a[2] ? l : a), bar.levels[0]!)[0];
  const imb = new Map(bar.imbalances.map((m) => [`${m.price}:${m.side}`, true]));
  const stacks = signals.filter((s) => s.barStart === bar.start && s.type === "stackedImbalance");
  const stacked = (price: number) => stacks.find((s) => price >= s.priceLo && price < s.priceHi);

  return (
    <div className="font-mono text-xs">
      <div className="grid grid-cols-[1fr_72px_1fr] border-b pb-1 text-[11px] text-muted-foreground">
        <span className="text-right text-sell">Vendedores (bid)</span>
        <span className="text-center">Precio</span>
        <span className="text-buy">Compradores (ask)</span>
      </div>
      <div className="max-h-80 overflow-auto">
        {rows.map(([price, bid, ask]) => {
          const st = stacked(price);
          return (
            <div key={price} className="grid h-[18px] grid-cols-[1fr_72px_1fr] items-center">
              <div
                className={cn("pr-2 text-right", imb.has(`${price}:sell`) && "font-bold text-sell ring-1 ring-inset ring-sell/70")}
                style={{ background: `rgba(246,70,93,${(bid / maxVol) * 0.55})` }}
              >
                {fmtVol(bid)}
              </div>
              <div className={cn("relative text-center text-muted-foreground", price === poc && "font-bold text-warn")}>
                {st && <span className={cn("absolute left-0 top-0 h-full w-1", st.bias === "bullish" ? "bg-buy" : "bg-sell")} />}
                {fmtLevel(price)}
                {price === poc && <span className="ml-0.5 text-[9px]">POC</span>}
              </div>
              <div
                className={cn("pl-2", imb.has(`${price}:buy`) && "font-bold text-buy ring-1 ring-inset ring-buy/70")}
                style={{ background: `rgba(14,203,129,${(ask / maxVol) * 0.55})` }}
              >
                {fmtVol(ask)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Recuadro = desequilibrio diagonal (3:1) · barra lateral = apilado · POC = nivel con más volumen
      </div>
    </div>
  );
}

/** Tabla de barras de 1 min (con delta, CVD y señales) + escalera footprint de la barra elegida. */
export function FootprintPanel({ bars, signals }: { bars: FootprintBar[]; signals: OrderflowSignal[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const list = [...bars].reverse();
  const current = list.find((b) => b.start === selected) ?? list[0];
  const asset = useAsset();

  return (
    <Panel
      id={`${asset}.footprint`}
      title="Footprint por barra"
      description="Elige una barra para ver su volumen vendedor/comprador en cada nivel de precio."
      contentClassName="grid @4xl:grid-cols-[1.4fr_1fr]"
    >
        <div className="max-h-[26rem] overflow-auto">
          <Table className="font-mono text-xs">
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Hora</TableHead>
                <TableHead className="text-right">Cierre</TableHead>
                <TableHead className="text-right">Volumen</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead className="text-right">CVD</TableHead>
                <TableHead>Señales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((b) => {
                const sigs = signals.filter((s) => s.barStart === b.start);
                return (
                  <TableRow
                    key={b.start}
                    onClick={() => setSelected(b.start)}
                    className={cn("cursor-pointer", current?.start === b.start && "bg-muted")}
                  >
                    <TableCell>
                      {fmtClockHM(b.start)}
                      {!b.closed && <span className="ml-1 text-warn">●</span>}
                    </TableCell>
                    <TableCell className="text-right">{b.close.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{b.volume.toFixed(2)}</TableCell>
                    <TableCell className={cn("text-right", b.delta >= 0 ? "text-buy" : "text-sell")}>{signed(b.delta, 3)}</TableCell>
                    <TableCell className="text-right">{b.cvdClose.toFixed(2)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {sigs.map((s) => (
                          <Badge key={s.id} variant="outline" className={cn("h-4 px-1 text-[10px]", biasText(s.bias))} title={SIGNAL_INFO[s.type].label}>
                            {SIGNAL_INFO[s.type].short}
                            {biasArrow(s.bias)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!list.length && <p className="p-4 text-sm text-muted-foreground">Esperando datos…</p>}
        </div>
        <div className="border-t p-3 sm:p-4 @4xl:border-t-0 @4xl:border-l">
          {current ? (
            <>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold">
                  Barra {fmtClockHM(current.start)} {!current.closed && <span className="text-warn">(en formación)</span>}
                </span>
                <span className="font-mono text-muted-foreground">
                  O {current.open.toFixed(2)} · H {current.high.toFixed(2)} · L {current.low.toFixed(2)} · C {current.close.toFixed(2)}
                </span>
              </div>
              <Ladder bar={current} signals={signals} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Sin barras todavía.</p>
          )}
        </div>
    </Panel>
  );
}
