"use client";

import { memo, useMemo, useState } from "react";
import type { PmDecision, PmEngineId, PmEngineThresholds, PmMarketRow, PmSideDecision } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { actionKey, BLOCK_HELP, BLOCK_LABEL, cents, edgeCents, ENGINE_DESC, ENGINE_IDS, ENGINE_LABEL, pct, SAME_RULES, signalLabel, stateKey } from "@/lib/engines";
import { fmtClockHM } from "@/lib/flow";
import type { EnginesView } from "@/lib/useEngines";

const ROWS = 60;
const RECENT = 24;
const money = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
const cls = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "text-buy" : "text-sell");

/** Una linea "Comprar Up: +2.1¢ / +4.0¢ · EV bajo" */
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
function EngineCard({ id, hint, d, trades, th, maker }: { id: PmEngineId; hint: string; d: PmDecision | undefined; trades: number; th: PmEngineThresholds; maker: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
      <div className="flex flex-col">
        <span className="font-medium">{ENGINE_LABEL[id]}</span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      {!d ? (
        <p className="text-muted-foreground">Sin decisiones todavía.</p>
      ) : (
        <>
          <div>
            <div className="text-[11px] text-muted-foreground">P(Up) con que decide</div>
            <div className="font-mono text-lg font-semibold text-violet-400">{pct(d.pUp)}</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              modelo {pct(d.pModel)} · mercado {pct(d.pMarket)} · faltan {d.tau.toFixed(0)}s
            </div>
          </div>
          <div className="flex flex-col font-mono text-[11px]">
            <span className="text-buy">
              Up {cents(d.upBid)}/{cents(d.upAsk)} · {d.up.shares} tk
            </span>
            <span className="text-sell">
              Down {cents(d.downBid)}/{cents(d.downAsk)} · {d.down.shares} tk
            </span>
          </div>
          <div className="flex flex-col gap-0.5 border-t pt-2">
            <Verdict label={maker ? "Bid Up" : "Comprar Up"} edge={d.up.buyEdge} block={d.up.buy} threshold={th.minEdge} />
            <Verdict label={maker ? "Bid Down" : "Comprar Down"} edge={d.down.buyEdge} block={d.down.buy} threshold={th.minEdge} />
            {d.up.sell !== "flat" && <Verdict label={maker ? "Ask Up" : "Vender Up"} edge={d.up.sellEdge} block={d.up.sell} threshold={th.exitMargin} />}
            {d.down.sell !== "flat" && <Verdict label={maker ? "Ask Down" : "Vender Down"} edge={d.down.sellEdge} block={d.down.sell} threshold={th.exitMargin} />}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {trades} {maker ? "salidas de emergencia" : "órdenes"} decididas en este market
            {d.signals.length > 0 && <> · ahora: <b className="text-foreground">{d.signals.map(signalLabel).join(", ")}</b></>}
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
  const side = (n: string, s: PmSideDecision) => (s.sell !== "flat" ? `${n} vender ${edgeCents(s.sellEdge)} ${BLOCK_LABEL[s.sell]}` : `${n} ${edgeCents(s.buyEdge)} ${BLOCK_LABEL[s.buy]}`);
  return (
    <span className="text-muted-foreground">
      {side("Up", d.up)} · {side("Dn", d.down)}
    </span>
  );
}

type Row = { sec: number; d: Partial<Record<PmEngineId, PmDecision>>; diffAction: boolean; diffState: boolean };

const Timeline = memo(function Timeline({ decisions, start }: { decisions: Record<PmEngineId, PmDecision[]>; start: number }) {
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    // todos los motores dejan un registro por segundo T de Binance (A y C con su retraso; D y E, el ultimo paso de ese segundo)
    const map = new Map<number, Row>();
    for (const id of ENGINE_IDS)
      for (const d of decisions[id]) {
        const sec = Math.round(d.time / 1000);
        const r = map.get(sec) ?? { sec, d: {}, diffAction: false, diffState: false };
        r.d[id] = d;
        map.set(sec, r);
      }
    const out = [...map.values()].sort((x, y) => y.sec - x.sec);
    for (const r of out) {
      // solo se comparan los motores con las mismas reglas (A y C); D y E deciden con otras
      const present = SAME_RULES.map((id) => r.d[id]).filter((d): d is PmDecision => !!d);
      if (present.length < 2) continue;
      r.diffAction = new Set(present.map(actionKey)).size > 1;
      r.diffState = !r.diffAction && new Set(present.map(stateKey)).size > 1;
    }
    return out;
  }, [decisions]);
  const full = rows.filter((r) => SAME_RULES.every((id) => r.d[id]));
  const sameActions = full.filter((r) => !r.diffAction).length;
  const sameState = full.filter((r) => !r.diffAction && !r.diffState).length;
  const shown = (onlyDiff ? rows.filter((r) => r.diffAction || r.diffState) : rows).slice(0, all ? undefined : ROWS);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          A y C (mismas reglas) en {full.length} segundos · misma acción {sameActions} · misma evaluación completa {sameState}
        </span>
        <label className="flex items-center gap-1.5">
          <Switch size="sm" checked={onlyDiff} onCheckedChange={setOnlyDiff} /> Solo diferencias A/C
        </label>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Seg.</TableHead>
              {ENGINE_IDS.map((id) => (
                <TableHead key={id}>
                  {ENGINE_LABEL[id]} <span className="font-normal text-muted-foreground">P(Up) · decide</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.sec} className={r.diffAction ? "bg-yellow-500/15" : r.diffState ? "bg-yellow-500/5" : ""}>
                <TableCell className="font-mono">+{Math.round((r.sec * 1000 - start) / 1000)}s</TableCell>
                {ENGINE_IDS.map((id) => (
                  <TableCell key={id} className="text-[11px] whitespace-normal">
                    <span className="mr-1 font-mono">{pct(r.d[id]?.pUp ?? null)}</span>
                    <Cell d={r.d[id]} />
                  </TableCell>
                ))}
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
 * Drawer de comparacion de motores A, C, D y E: la ultima decision de cada uno con sus razones, la linea de tiempo
 * segundo a segundo del market en curso, y el resultado de papel de todos en los markets guardados recientes.
 */
export function EnginesDrawer({
  open,
  onOpenChange,
  eng,
  rows,
  marketStart,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  eng: EnginesView;
  /** markets guardados (de la API), mas recientes primero */
  rows: PmMarketRow[];
  /** inicio del market en curso (para los segundos relativos) */
  marketStart: number;
}) {
  const th = eng.thresholds;
  const delay = (id: PmEngineId) => eng.info.find((e) => e.id === id);
  // solo las decisiones del market en curso (un motor puede ir un segundo por delante al rotar)
  const cur = ENGINE_IDS.map((id) => eng.tracks[id].slug).find((s) => s !== null) ?? null;
  const decisions = useMemo(
    () => Object.fromEntries(ENGINE_IDS.map((id) => [id, eng.tracks[id].slug === cur ? eng.tracks[id].decisions : []])) as Record<PmEngineId, PmDecision[]>,
    [eng.tracks, cur],
  );
  const recent = rows.slice(0, RECENT);
  const tot = Object.fromEntries(ENGINE_IDS.map((id) => [id, recent.reduce((s, r) => s + (r.engines[id].net ?? 0), 0)])) as Record<PmEngineId, number>;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-5xl">
        <SheetHeader>
          <SheetTitle>Motores A, C, D y E</SheetTitle>
          <SheetDescription>
            <b>A</b> y <b>C</b>: mismas reglas, una decisión por segundo de Binance (A justo al empezar el segundo con lo último recibido; C espera{" "}
            {delay("c")?.delayMs ?? 150} ms y usa solo datos con marca de tiempo de ese segundo). <b>D</b> (predictivo): decide cada {delay("d")?.delayMs ?? 100} ms
            con la deriva que anticipa el flujo de Binance, exige más EV y pone un precio límite; su papel se ejecuta con la latencia real de Polymarket.{" "}
            <b>E</b> (libro): deja órdenes límite en reposo sin comisión y las recoloca o cancela en cuanto la idea muere. Todos se guardan en la base.
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline">{eng.link === "open" ? "conectado" : eng.link === "connecting" ? "conectando…" : "desconectado"}</Badge>
          {th && (
            <span>
              Umbrales de A y C: comprar si EV ≥ {edgeCents(th.minEdge)} · vender si supera a mantener en {edgeCents(th.exitMargin)} · spread máx. {cents(th.maxSpread)} ·
              sin entradas los primeros {th.warmupS}s ni los últimos {th.noEntryS}s. D y E muestran los suyos en cada tarjeta.
            </span>
          )}
        </div>

        {th && (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {ENGINE_IDS.map((id) => {
              const info = delay(id);
              const ds = decisions[id];
              const own = info?.thresholds ?? th;
              const hint = !info
                ? ENGINE_DESC[id]
                : info.mode === "fast"
                  ? `${ENGINE_DESC[id]} · ${info.kind === "maker" ? `bid a ≥ ${edgeCents(own.minEdge)} bajo su valor, ask a ${edgeCents(own.exitMargin)} sobre él` : `EV ≥ ${edgeCents(own.minEdge)}, salida ${edgeCents(own.exitMargin)}`}`
                  : `${info.mode === "live" ? "lo último recibido" : "datos a fecha"} · segundo + ${info.delayMs} ms`;
              return <EngineCard key={id} id={id} hint={hint} d={ds[ds.length - 1]} trades={ds.reduce((n, d) => n + d.signals.length, 0)} th={own} maker={info?.kind === "maker"} />;
            })}
          </div>
        )}

        <h3 className="mt-1 text-sm font-medium">Segundo a segundo (market en curso)</h3>
        <p className="-mt-2 text-[11px] text-muted-foreground">
          Amarillo fuerte: algún motor hizo algo distinto. Amarillo suave: misma acción pero distinta evaluación (p. ej. uno &quot;EV bajo&quot; y otro
          &quot;espera&quot;). Edge en ¢ por token frente al umbral.
        </p>
        <Timeline decisions={decisions} start={marketStart} />

        <h3 className="mt-2 text-sm font-medium">Markets guardados recientes</h3>
        {recent.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Aún no hay markets guardados.</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Resultado</TableHead>
                  {ENGINE_IDS.map((id) => (
                    <TableHead key={id} className="text-right">
                      {ENGINE_LABEL[id]} ops · neto
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => (
                  <TableRow key={r.slug}>
                    <TableCell className="font-mono">{fmtClockHM(r.start)}</TableCell>
                    <TableCell className={r.result === "up" ? "text-buy" : "text-sell"}>{r.result === "up" ? "▲ Up" : "▼ Down"}</TableCell>
                    {ENGINE_IDS.map((id) => (
                      <TableCell key={id} className="text-right font-mono">
                        {r.engines[id].trades} · <span className={cls(r.engines[id].net)}>{money(r.engines[id].net)}</span>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={2} className="text-muted-foreground">
                    Total ({recent.length})
                  </TableCell>
                  {ENGINE_IDS.map((id) => (
                    <TableCell key={id} className={`text-right font-mono ${cls(tot[id])}`}>
                      {money(tot[id])}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
