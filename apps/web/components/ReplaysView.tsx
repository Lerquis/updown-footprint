"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PmReplayFill, PmReplayMarket } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useReplays } from "@/lib/useReplays";
import { cn } from "@/lib/utils";

type Gen = "all" | "v1" | "v2";

const usd = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
const cents = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}¢`;
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)} %`);
const tone = (v: number) => (v > 0 ? "text-buy" : v < 0 ? "text-sell" : "text-muted-foreground");
const fmtDate = (t: number) => new Date(t).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtTime = (t: number) => new Date(t).toLocaleTimeString("es", { hour12: false });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface RunStats {
  invested: number;
  net: number;
  roi: number | null;
  buys: number;
  missedBuys: number;
  sells: number;
  missedSells: number;
  /** precio de ejecucion - precio de la senal, en las ejecutadas */
  buySlip: number | null;
  sellSlip: number | null;
  wins: number;
  losses: number;
}

function runStats(markets: PmReplayMarket[], i: number): RunStats {
  const s: RunStats = { invested: 0, net: 0, roi: null, buys: 0, missedBuys: 0, sells: 0, missedSells: 0, buySlip: null, sellSlip: null, wins: 0, losses: 0 };
  const bs: number[] = [];
  const ss: number[] = [];
  for (const m of markets) {
    const run = m.runs[i]!;
    s.invested += run.pnl.invested;
    const net = run.pnl.net ?? 0;
    s.net += net;
    if (run.pnl.invested > 0) {
      if (net > 0) s.wins++;
      else if (net < 0) s.losses++;
    }
    for (const f of run.fills) {
      const slip = f.execPrice === null ? null : f.execPrice - f.signalPrice;
      if (f.action === "buy") {
        s.buys++;
        if (slip === null) s.missedBuys++;
        else bs.push(slip);
      } else {
        s.sells++;
        if (f.status === "missed") s.missedSells++;
        if (slip !== null) ss.push(slip);
      }
    }
  }
  s.roi = s.invested > 0 ? s.net / s.invested : null;
  s.buySlip = mean(bs);
  s.sellSlip = mean(ss);
  return s;
}

function Stat({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-lg tabular-nums", className)}>{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** Neto acumulado market a market (orden cronologico): referencia (0 s) frente al retraso elegido. Una sola escala. */
function CumulativeChart({ markets, delayIdx, delayS }: { markets: PmReplayMarket[]; delayIdx: number; delayS: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = useMemo(() => {
    let a = 0;
    let b = 0;
    return markets.map((m) => {
      a += m.runs[0]!.pnl.net ?? 0;
      b += m.runs[delayIdx]!.pnl.net ?? 0;
      return { m, base: a, delayed: b };
    });
  }, [markets, delayIdx]);

  if (series.length < 2) return <p className="text-sm text-muted-foreground">Hacen falta al menos 2 markets con operaciones.</p>;
  const H = 260;
  const pad = { l: 56, r: 64, t: 12, b: 24 };
  const vals = series.flatMap((p) => [p.base, p.delayed]).concat(0);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => pad.l + (i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
  const path = (k: "base" | "delayed") => series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const ticks = [lo, lo + span / 2, hi];
  const last = series[series.length - 1]!;
  const h = hover === null ? null : series[hover]!;

  return (
    <div ref={box} className="relative w-full">
      <svg
        width={width}
        height={H}
        className="block"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pad.l) / (width - pad.l - pad.r)) * (series.length - 1));
          setHover(Math.min(series.length - 1, Math.max(0, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
              {t.toFixed(0)}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} className="stroke-muted-foreground/60" strokeWidth={1} strokeDasharray="3 3" />
        <path d={path("base")} fill="none" className="stroke-muted-foreground" strokeWidth={2} strokeLinejoin="round" />
        <path d={path("delayed")} fill="none" className="stroke-gold" strokeWidth={2} strokeLinejoin="round" />
        <text x={x(series.length - 1) + 6} y={y(last.base) + 4} className="fill-muted-foreground text-[11px]">
          0 s
        </text>
        <text x={x(series.length - 1) + 6} y={y(last.delayed) + 4} className="fill-foreground text-[11px]">
          +{delayS} s
        </text>
        {h && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="stroke-foreground/40" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(h.base)} r={4} className="fill-muted-foreground stroke-card" strokeWidth={2} />
            <circle cx={x(hover)} cy={y(h.delayed)} r={4} className="fill-gold stroke-card" strokeWidth={2} />
          </g>
        )}
        <text x={pad.l} y={H - 6} className="fill-muted-foreground text-[10px]">
          {fmtDate(series[0]!.m.start)}
        </text>
        <text x={width - pad.r} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
          {fmtDate(last.m.start)}
        </text>
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border bg-popover px-2 py-1.5 text-[11px] shadow-md"
          style={{ left: Math.min(x(hover) + 10, width - 190) }}
        >
          <div className="text-muted-foreground">
            {fmtDate(h.m.start)} · {h.m.generation} · {h.m.result === "up" ? "Up" : "Down"}
          </div>
          <div className="flex justify-between gap-4 font-mono">
            <span className="text-muted-foreground">0 s</span>
            <span>{usd(h.base)}</span>
          </div>
          <div className="flex justify-between gap-4 font-mono">
            <span className="text-gold">+{delayS} s</span>
            <span>{usd(h.delayed)}</span>
          </div>
          <div className="text-muted-foreground">
            market: {usd(h.m.runs[0]!.pnl.net ?? 0)} → {usd(h.m.runs[delayIdx]!.pnl.net ?? 0)}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS: Record<PmReplayFill["status"], string> = { filled: "ejecutada", missed: "sin precio", noPosition: "sin tokens" };

function FillsTable({ m, delayIdx, delayS }: { m: PmReplayMarket; delayIdx: number; delayS: number }) {
  const base = m.runs[0]!.fills;
  const late = m.runs[delayIdx]!.fills;
  return (
    <table className="w-full text-[11px]">
      <thead className="text-muted-foreground">
        <tr className="text-left">
          <th className="py-1 font-normal">Señal</th>
          <th className="font-normal">Orden</th>
          <th className="text-right font-normal">Precio 0 s</th>
          <th className="text-right font-normal">Precio +{delayS} s</th>
          <th className="text-right font-normal">Diferencia</th>
          <th className="text-right font-normal">Tokens 0 s → +{delayS} s</th>
          <th className="text-right font-normal">USDC 0 s → +{delayS} s</th>
          <th className="pl-3 font-normal">Estado +{delayS} s</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {late.map((f, i) => {
          const b = base[i]!;
          const diff = f.execPrice === null ? null : f.execPrice - f.signalPrice;
          // para una compra, pagar mas es peor; para una venta, cobrar menos es peor
          const bad = diff === null ? 0 : f.action === "buy" ? -diff : diff;
          return (
            <tr key={i} className="border-t border-border/50">
              <td className="py-1">{fmtTime(f.time)}</td>
              <td className={f.action === "buy" ? "text-buy" : "text-sell"}>
                {f.action === "buy" ? "Compra" : "Venta"} {f.side === "up" ? "Up" : "Down"}
              </td>
              <td className="text-right">{(f.signalPrice * 100).toFixed(1)}¢</td>
              <td className="text-right">{f.execPrice === null ? "–" : `${(f.execPrice * 100).toFixed(1)}¢`}</td>
              <td className={cn("text-right", tone(bad))}>{diff === null ? "–" : cents(diff)}</td>
              <td className="text-right">
                {b.shares.toFixed(1)} → {f.shares.toFixed(1)}
              </td>
              <td className="text-right">
                {b.amount.toFixed(2)} → {f.amount.toFixed(2)}
              </td>
              <td className={cn("pl-3 font-sans", f.status !== "filled" && "text-sell")}>{STATUS[f.status]}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ReplaysView() {
  const state = useReplays();
  const [delay, setDelay] = useState(1);
  const [gen, setGen] = useState<Gen>("all");
  const [open, setOpen] = useState<string | null>(null);

  const report = state.status === "ready" ? state.report : null;
  const delayIdx = Math.max(0, report?.delays.indexOf(delay) ?? 0);
  const markets = useMemo(() => (report ? report.markets.filter((m) => gen === "all" || m.generation === gen) : []), [report, gen]);
  const traded = useMemo(() => markets.filter((m) => m.runs[0]!.fills.length > 0), [markets]);
  const all = useMemo(() => (report ? report.delays.map((_, i) => runStats(traded, i)) : []), [report, traded]);

  if (state.status === "loading") return <main className="p-6 text-sm text-muted-foreground">Cargando replays…</main>;
  if (state.status === "error")
    return (
      <main className="p-6 text-sm">
        <p className="text-sell">No se pudo cargar el informe de replays.</p>
        <p className="mt-1 text-muted-foreground">{state.message}</p>
      </main>
    );

  const r = state.report;
  const base = all[0]!;
  const cur = all[delayIdx]!;
  const v1 = r.markets.filter((m) => m.generation === "v1");
  const v2 = r.markets.filter((m) => m.generation === "v2");

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Replays · motor A con ejecución retrasada</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            El motor A decide igual que siempre en el segundo de la señal, pero cada orden se ejecuta {delay === 0 ? "en ese mismo instante" : `${delay} s después`}, con el libro de ese momento:
            compra al ask (mismo importe en USDC) y vende al bid los tokens que de verdad compró. Comisión y deslizamiento iguales que en el paper. 0 s es la referencia.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup variant="outline" size="sm" spacing={0} value={[String(delay)]} onValueChange={(v) => v[0] !== undefined && setDelay(Number(v[0]))}>
            {r.delays.map((d) => (
              <ToggleGroupItem key={d} value={String(d)} title={d === 0 ? "Referencia: ejecución en el segundo de la señal" : `Ejecución ${d} s después de la señal`}>
                {d === 0 ? "0 s" : `+${d} s`}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup variant="outline" size="sm" spacing={0} value={[gen]} onValueChange={(v) => v[0] !== undefined && setGen(v[0] as Gen)}>
            <ToggleGroupItem value="all">Todas</ToggleGroupItem>
            <ToggleGroupItem value="v1" title="Base v1 (archivo del servidor remoto)">
              v1 · {v1.length}
            </ToggleGroupItem>
            <ToggleGroupItem value="v2" title="Base v2 (copias horarias en R2)">
              v2 · {v2.length}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Markets con operaciones" value={`${traded.length}`} sub={`de ${markets.length} reproducidos`} />
        <Stat label="Neto 0 s (referencia)" value={usd(base.net)} sub={`ROI ${pct(base.roi)}`} className={tone(base.net)} />
        <Stat label={`Neto +${delay} s`} value={usd(cur.net)} sub={`ROI ${pct(cur.roi)} · invertido ${cur.invested.toFixed(0)}`} className={tone(cur.net)} />
        <Stat
          label="Diferencia por el retraso"
          value={usd(cur.net - base.net)}
          sub={base.net !== 0 ? `${(((cur.net - base.net) / Math.abs(base.net)) * 100).toFixed(0)} % del neto` : undefined}
          className={tone(cur.net - base.net)}
        />
        <Stat
          label="Precio medio vs señal"
          value={cur.buySlip === null ? "–" : cents(cur.buySlip)}
          sub={`compras · ventas ${cur.sellSlip === null ? "–" : cents(cur.sellSlip)}`}
          className={cur.buySlip === null ? undefined : tone(-cur.buySlip)}
        />
        <Stat
          label="Órdenes sin ejecutar"
          value={`${cur.missedBuys + cur.missedSells}`}
          sub={`${cur.missedBuys}/${cur.buys} compras · ${cur.missedSells}/${cur.sells} ventas`}
          className={cur.missedBuys + cur.missedSells ? "text-sell" : undefined}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Neto acumulado (USDC)</CardTitle>
          <CardDescription>
            Markets con operaciones en orden cronológico. <span className="text-muted-foreground">━ 0 s (referencia)</span> · <span className="text-gold">━ +{delay} s</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CumulativeChart markets={traded} delayIdx={delayIdx} delayS={delay} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Todos los retrasos</CardTitle>
          <CardDescription>Mismas señales; solo cambia el instante de ejecución.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Retraso</TableHead>
                <TableHead className="text-right">Invertido</TableHead>
                <TableHead className="text-right">Neto</TableHead>
                <TableHead className="text-right">ROI</TableHead>
                <TableHead className="text-right">vs 0 s</TableHead>
                <TableHead className="text-right">Markets + / −</TableHead>
                <TableHead className="text-right">Compra vs señal</TableHead>
                <TableHead className="text-right">Venta vs señal</TableHead>
                <TableHead className="text-right">Sin ejecutar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {r.delays.map((d, i) => {
                const s = all[i]!;
                return (
                  <TableRow key={d} className={cn("cursor-pointer", d === delay && "bg-muted/50")} onClick={() => setDelay(d)}>
                    <TableCell className="font-sans">{d === 0 ? "0 s (referencia)" : `+${d} s`}</TableCell>
                    <TableCell className="text-right">{s.invested.toFixed(2)}</TableCell>
                    <TableCell className={cn("text-right", tone(s.net))}>{usd(s.net)}</TableCell>
                    <TableCell className="text-right">{pct(s.roi)}</TableCell>
                    <TableCell className={cn("text-right", tone(s.net - base.net))}>{i === 0 ? "–" : usd(s.net - base.net)}</TableCell>
                    <TableCell className="text-right">
                      {s.wins} / {s.losses}
                    </TableCell>
                    <TableCell className="text-right">{s.buySlip === null ? "–" : cents(s.buySlip)}</TableCell>
                    <TableCell className="text-right">{s.sellSlip === null ? "–" : cents(s.sellSlip)}</TableCell>
                    <TableCell className="text-right">{s.missedBuys + s.missedSells}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Markets con operaciones</CardTitle>
          <CardDescription>Más recientes primero. Clic en una fila para ver cada orden: precio de la señal frente al de +{delay} s.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Inicio</TableHead>
                <TableHead>Base</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead className="text-right">Órdenes</TableHead>
                <TableHead className="text-right">Invertido</TableHead>
                <TableHead className="text-right">Neto 0 s</TableHead>
                <TableHead className="text-right">Neto +{delay} s</TableHead>
                <TableHead className="text-right">Diferencia</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...traded].reverse().map((m) => {
                const a = m.runs[0]!.pnl.net ?? 0;
                const b = m.runs[delayIdx]!.pnl.net ?? 0;
                const isOpen = open === m.slug;
                return (
                  <Fragment key={m.slug}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(isOpen ? null : m.slug)}>
                      <TableCell className="font-mono text-xs">{fmtDate(m.start)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{m.generation}</Badge>
                      </TableCell>
                      <TableCell className={m.result === "up" ? "text-buy" : "text-sell"}>{m.result === "up" ? "Up" : "Down"}</TableCell>
                      <TableCell className="text-right font-mono">{m.runs[0]!.fills.length}</TableCell>
                      <TableCell className="text-right font-mono">{m.runs[delayIdx]!.pnl.invested.toFixed(2)}</TableCell>
                      <TableCell className={cn("text-right font-mono", tone(a))}>{usd(a)}</TableCell>
                      <TableCell className={cn("text-right font-mono", tone(b))}>{usd(b)}</TableCell>
                      <TableCell className={cn("text-right font-mono", tone(b - a))}>{usd(b - a)}</TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="bg-muted/30">
                          <FillsTable m={m} delayIdx={delayIdx} delayS={delay} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <footer className="text-[11px] text-muted-foreground">
        Fuentes (bucket R2, no se usan las bases locales):{" "}
        {r.sources.map((s) => `${s.key} (${s.generation}, ${s.markets} markets)`).join(" · ")}. Generado con <code>npm run replays -w @updown/server</code>.
      </footer>
    </main>
  );
}
