"use client";

import { memo, useMemo, useState } from "react";
import type { PmDecision, PmEngineThresholds, PmRecord, PmSideDecision } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { actionKey, BLOCK_HELP, BLOCK_LABEL, cents, edgeCents, paperNet, pct, signalLabel, stateKey } from "@/lib/engines";
import { fmtClockHM } from "@/lib/flow";
import type { EnginesView } from "@/lib/useEngines";

const ROWS = 60;
const money = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
const cls = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "text-buy" : "text-sell");

/** Una linea "Comprar Up: +2.1¢ (umbral 4¢) · EV bajo" */
function Verdict({ label, edge, block, threshold }: { label: string; edge: number | null; block: PmSideDecision["buy"]; threshold: number }) {
  const ok = block === "ok";
  return (
    <div className="flex items-baseline justify-between gap-2" title={BLOCK_HELP[block]}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">
        <span className={edge !== null && edge >= threshold ? "text-buy" : ""}>{edgeCents(edge)}</span>
        <span className="text-muted-foreground"> / {edgeCents(threshold)}</span>{" "}
        <span className={ok ? "font-semibold text-buy" : "text-muted-foreground"}>{BLOCK_LABEL[block]}</span>
      </span>
    </div>
  );
}

/** Estado en vivo de un motor: ultima decision y sus razones. */
function EngineCard({ title, hint, d, trades, th }: { title: string; hint: string; d: PmDecision | undefined; trades: number; th: PmEngineThresholds }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{title}</span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      {!d ? (
        <p className="text-muted-foreground">Sin decisiones todavía.</p>
      ) : (
        <>
          <div className="flex items-end gap-4">
            <div>
              <div className="text-[11px] text-muted-foreground">P(Up) decide</div>
              <div className="font-mono text-lg font-semibold text-violet-400">{pct(d.pUp)}</div>
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              modelo {pct(d.pModel)} · mercado {pct(d.pMarket)}
              <br />
              faltan {d.tau.toFixed(0)}s · Chainlink {d.chainlink?.toFixed(2) ?? "–"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 font-mono text-[11px]">
            <span className="text-buy">
              Up {cents(d.upBid)}/{cents(d.upAsk)} · {d.up.shares} tk
            </span>
            <span className="text-sell">
              Down {cents(d.downBid)}/{cents(d.downAsk)} · {d.down.shares} tk
            </span>
          </div>
          <div className="flex flex-col gap-0.5 border-t pt-2">
            <Verdict label="Comprar Up" edge={d.up.buyEdge} block={d.up.buy} threshold={th.minEdge} />
            <Verdict label="Comprar Down" edge={d.down.buyEdge} block={d.down.buy} threshold={th.minEdge} />
            {d.up.sell !== "flat" && <Verdict label="Vender Up" edge={d.up.sellEdge} block={d.up.sell} threshold={th.exitMargin} />}
            {d.down.sell !== "flat" && <Verdict label="Vender Down" edge={d.down.sellEdge} block={d.down.sell} threshold={th.exitMargin} />}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {trades} operaciones en este market{d.signals.length > 0 && <> · ahora: <b className="text-foreground">{d.signals.map(signalLabel).join(", ")}</b></>}
          </div>
        </>
      )}
    </div>
  );
}

/** Resumen compacto de una decision para la linea de tiempo */
function Cell({ d }: { d: PmDecision | undefined }) {
  if (!d) return <span className="text-muted-foreground">–</span>;
  if (d.signals.length) return <b className={d.signals[0]!.side === "up" ? "text-buy" : "text-sell"}>{d.signals.map(signalLabel).join(", ")}</b>;
  const side = (n: string, s: PmSideDecision) =>
    s.sell !== "flat" ? `${n} vender ${edgeCents(s.sellEdge)} ${BLOCK_LABEL[s.sell]}` : `${n} ${edgeCents(s.buyEdge)} ${BLOCK_LABEL[s.buy]}`;
  return (
    <span className="text-muted-foreground">
      {side("Up", d.up)} · {side("Dn", d.down)}
    </span>
  );
}

interface Row {
  sec: number;
  a?: PmDecision;
  b?: PmDecision;
  diffAction: boolean;
  diffState: boolean;
}

const Timeline = memo(function Timeline({ a, b, start }: { a: PmDecision[]; b: PmDecision[]; start: number }) {
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    // A muestrea en un instante cualquiera del segundo; se empareja con la decision de B del segundo mas cercano
    const map = new Map<number, Row>();
    const get = (sec: number) => map.get(sec) ?? (map.set(sec, { sec, diffAction: false, diffState: false }), map.get(sec)!);
    for (const d of a) get(Math.round(d.time / 1000)).a = d;
    for (const d of b) get(Math.round(d.time / 1000)).b = d;
    const out = [...map.values()].sort((x, y) => y.sec - x.sec);
    for (const r of out) {
      if (!r.a || !r.b) continue; // solo se compara cuando ambos decidieron ese segundo
      r.diffAction = actionKey(r.a) !== actionKey(r.b);
      r.diffState = !r.diffAction && stateKey(r.a) !== stateKey(r.b);
    }
    return out;
  }, [a, b]);
  const both = rows.filter((r) => r.a && r.b);
  const sameActions = both.filter((r) => !r.diffAction).length;
  const sameState = both.filter((r) => !r.diffAction && !r.diffState).length;
  const shown = (onlyDiff ? rows.filter((r) => r.diffAction || r.diffState) : rows).slice(0, all ? undefined : ROWS);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Segundos comparados: {both.length} · misma acción {sameActions} · misma evaluación completa {sameState}
        </span>
        <label className="flex items-center gap-1.5">
          <Switch size="sm" checked={onlyDiff} onCheckedChange={setOnlyDiff} /> Solo diferencias
        </label>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Seg.</TableHead>
              <TableHead className="w-14 text-right">A P(Up)</TableHead>
              <TableHead>A decide</TableHead>
              <TableHead className="w-14 text-right">B P(Up)</TableHead>
              <TableHead>B decide</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.sec} className={r.diffAction ? "bg-yellow-500/15" : r.diffState ? "bg-yellow-500/5" : ""}>
                <TableCell className="font-mono">+{Math.round((r.sec * 1000 - start) / 1000)}s</TableCell>
                <TableCell className="text-right font-mono">{pct(r.a?.pUp ?? null)}</TableCell>
                <TableCell className="text-[11px]">
                  <Cell d={r.a} />
                </TableCell>
                <TableCell className="text-right font-mono">{pct(r.b?.pUp ?? null)}</TableCell>
                <TableCell className="text-[11px]">
                  <Cell d={r.b} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!all && rows.length > ROWS && (
        <Button size="sm" variant="outline" onClick={() => setAll(true)}>
          Ver todo el market
        </Button>
      )}
    </div>
  );
});

/**
 * Drawer de comparacion de motores: A (principal, el que se guarda) y B (sincronizado, solo en memoria).
 * Muestra la ultima decision de cada uno con sus razones, la linea de tiempo segundo a segundo y el resultado
 * de papel de ambos en los markets recientes.
 */
export function EnginesDrawer({
  open,
  onOpenChange,
  eng,
  history,
  marketStart,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  eng: EnginesView;
  history: PmRecord[];
  /** inicio del market en curso (para los segundos relativos) */
  marketStart: number;
}) {
  const th = eng.thresholds;
  const lastA = eng.a.decisions[eng.a.decisions.length - 1];
  const lastB = eng.b.decisions[eng.b.decisions.length - 1];
  const sameMarket = eng.a.slug !== null && eng.a.slug === eng.b.slug;

  const recent = useMemo(() => {
    const bBySlug = new Map(eng.bHistory.map((h) => [h.slug, h.trades]));
    return history
      .filter((r) => bBySlug.has(r.market.slug))
      .slice()
      .reverse()
      .map((r) => {
        const bt = bBySlug.get(r.market.slug)!;
        return { slug: r.market.slug, start: r.market.start, result: r.market.result, aOps: r.trades.length, aNet: r.pnl.net, bOps: bt.length, bNet: paperNet(bt, r.market.result) };
      });
  }, [eng.bHistory, history]);
  const tot = recent.reduce((s, r) => ({ a: s.a + (r.aNet ?? 0), b: s.b + (r.bNet ?? 0) }), { a: 0, b: 0 });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Motores A y B</SheetTitle>
          <SheetDescription>
            <b>A</b>: el motor principal (muestrea con el reloj del servidor; es el que se guarda en la base). <b>B</b>: mismas reglas, pero decide en el
            segundo exacto de Binance (+{eng.syncDelayMs} ms) con los datos que había en ese instante, para que servidores distintos decidan lo mismo. B solo
            vive en memoria.
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline">{eng.link === "open" ? "conectado" : eng.link === "connecting" ? "conectando…" : "desconectado"}</Badge>
          {th && (
            <span>
              Umbrales: comprar si EV ≥ {edgeCents(th.minEdge)} · vender si supera a mantener en {edgeCents(th.exitMargin)} · spread máx. {cents(th.maxSpread)} · sin
              entradas los primeros {th.warmupS}s ni los últimos {th.noEntryS}s
            </span>
          )}
        </div>

        {th && (
          <div className="grid gap-2 sm:grid-cols-2">
            <EngineCard title="A · principal" hint={lastA ? `decide en +${(lastA.time % 1000) / 1000}s del segundo` : ""} d={lastA} trades={eng.a.trades.length} th={th} />
            <EngineCard title="B · sincronizado" hint={`segundo exacto +${eng.syncDelayMs} ms`} d={sameMarket || !lastA ? lastB : undefined} trades={eng.b.trades.length} th={th} />
          </div>
        )}

        <h3 className="mt-1 text-sm font-medium">Segundo a segundo (market en curso)</h3>
        <p className="-mt-2 text-[11px] text-muted-foreground">
          Amarillo fuerte: A y B hicieron algo distinto. Amarillo suave: misma acción pero distinta evaluación (p. ej. uno &quot;EV bajo&quot; y otro &quot;espera&quot;). Edge
          en ¢ por token frente al umbral.
        </p>
        <Timeline a={eng.a.decisions} b={sameMarket ? eng.b.decisions : []} start={marketStart} />

        <h3 className="mt-2 text-sm font-medium">Markets recientes: A vs B</h3>
        {recent.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Aún no hay markets terminados con el motor B (se acumulan desde que arrancó el servidor; no se guardan).</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Resultado</TableHead>
                  <TableHead className="text-right">A ops</TableHead>
                  <TableHead className="text-right">A neto</TableHead>
                  <TableHead className="text-right">B ops</TableHead>
                  <TableHead className="text-right">B neto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => (
                  <TableRow key={r.slug}>
                    <TableCell className="font-mono">{fmtClockHM(r.start)}</TableCell>
                    <TableCell className={r.result === "up" ? "text-buy" : r.result === "down" ? "text-sell" : "text-muted-foreground"}>
                      {r.result === "up" ? "▲ Up" : r.result === "down" ? "▼ Down" : "…"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{r.aOps}</TableCell>
                    <TableCell className={`text-right font-mono ${cls(r.aNet)}`}>{money(r.aNet)}</TableCell>
                    <TableCell className="text-right font-mono">{r.bOps}</TableCell>
                    <TableCell className={`text-right font-mono ${cls(r.bNet)}`}>{money(r.bNet)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    Total ({recent.length})
                  </TableCell>
                  <TableCell className={`text-right font-mono ${cls(tot.a)}`}>{money(tot.a)}</TableCell>
                  <TableCell />
                  <TableCell className={`text-right font-mono ${cls(tot.b)}`}>{money(tot.b)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
