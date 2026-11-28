"use client";

import { ASSET_INFO, SOURCE_LABEL, useAsset, useSource } from "@/lib/source";
import { useEffect, useMemo, useState } from "react";
import { STRENGTH_VARIANTS, type PmEngineId, type PmMarketRow, type PmPnl, type PmRecord, type PmSignal, type PmStrengthSet } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exchangeClock } from "@/lib/exchangeClock";
import { fmtClockHM, fmtDayShort } from "@/lib/flow";
import type { OrderflowView } from "@/lib/useOrderflow";
import { useFetchRecord, useMarketRows } from "@/lib/useMarketRows";
import { sliceFlow, type PolymarketView } from "@/lib/usePolymarket";
import { useEngines } from "@/lib/useEngines";
import { useTrading } from "@/lib/useTrading";
import { ENGINE_DESC, ENGINE_IDS, ENGINE_LABEL, STRENGTH_LABEL } from "@/lib/engines";
import { VENUES, type Venue } from "@/lib/venue";
import { EnginesDrawer } from "./EnginesDrawer";
import { LiveTradingCard } from "./LiveTradingCard";
import { LiveBadge } from "./LiveBadge";
import { Panel } from "./Panel";
import { PolymarketChart, type EngineSeries } from "./PolymarketChart";

const LIVE = "live";
const PAGE_SIZE = 50;
const EMPTY_PNL: PmPnl = { invested: 0, sold: 0, openUp: 0, openDown: 0, net: null, roi: null };
const cents = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(0)}¢`);
const usd = (v: number | null) => (v === null ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sign = (v: number) => (v > 0 ? "+" : "");
const cls = (v: number | null) => (v === null || v === 0 ? "" : v > 0 ? "text-buy" : "text-sell");

/** El resultado oficial no siempre coincide con apertura/cierre (la resolución usa el TWAP de Chainlink): se avisa. */
type Resolvable = Pick<PmMarketRow, "priceToBeat" | "closePrice"> & { result: "up" | "down" | null };
function disagrees(m: Resolvable): boolean {
  return m.result !== null && m.priceToBeat !== null && m.closePrice !== null && (m.closePrice >= m.priceToBeat) !== (m.result === "up");
}

function Mismatch({ m }: { m: Resolvable }) {
  if (!disagrees(m)) return null;
  return (
    <span className="cursor-help text-warn" title="El resultado oficial no coincide con apertura/cierre (ambos TWAP). Es un caso raro: revísalo en Polymarket.">
      ⚠
    </span>
  );
}

function ResultBadge({ result }: { result: "up" | "down" | null }) {
  if (!result) return <Badge variant="outline" className="text-muted-foreground">resolviendo…</Badge>;
  return (
    <Badge variant="outline" className={result === "up" ? "border-buy/40 text-buy" : "border-sell/40 text-sell"}>
      {result === "up" ? "▲ Up" : "▼ Down"}
    </Badge>
  );
}

function Stat({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-background/60 px-3 py-2">
      <span className="truncate text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold tabular-nums ${className}`}>{children}</span>
    </div>
  );
}

const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(0)}%`);
const money = (v: number | null) => (v === null ? "–" : `${sign(v)}${v.toFixed(2)}`);

/** Compras / ventas de los motores en el market mostrado, por orden de tiempo. */
function TradesList({ engines, start }: { engines: EngineSeries[]; start: number }) {
  const all = engines.flatMap((e) => e.trades.map((t) => ({ e: e.id, t }))).sort((x, y) => x.t.time - y.t.time || x.e.localeCompare(y.e));
  if (!all.length) return <p className="text-[11px] text-muted-foreground">Ningún motor señaló operaciones en este market.</p>;
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Motor</TableHead>
            <TableHead>Hora</TableHead>
            <TableHead>Señal</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead className="text-right">Precio</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">USDC</TableHead>
            <TableHead className="text-right">P motor</TableHead>
            <TableHead className="text-right">Edge</TableHead>
            <TableHead className="text-right">Faltaban</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {all.map(({ e, t }) => (
            <TableRow key={`${e}${t.id}`}>
              <TableCell className="font-mono font-semibold">{e.toUpperCase()}</TableCell>
              <TableCell className="font-mono">+{Math.round((t.time - start) / 1000)}s</TableCell>
              <TableCell className={`font-semibold ${t.side === "up" ? "text-buy" : "text-sell"}`}>
                {t.action === "buy" ? "COMPRAR" : "VENDER"} {t.side === "up" ? "Up" : "Down"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {t.reason}
              </TableCell>
              <TableCell className="text-right font-mono">{cents(t.price)}</TableCell>
              <TableCell className="text-right font-mono">{t.shares}</TableCell>
              <TableCell className="text-right font-mono">{t.amount.toFixed(2)}</TableCell>
              <TableCell className="text-right font-mono">{pct(t.pSide)}</TableCell>
              <TableCell className="text-right font-mono">{(t.edge * 100).toFixed(1)}¢</TableCell>
              <TableCell className="text-right font-mono">{t.tau.toFixed(0)}s</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** SS: movimientos con fuerza de la P(Up) del motor C en el market mostrado, por variante (solo informativo, no opera). */
function StrengthList({ strength, start, refLabel }: { strength: PmStrengthSet; start: number; refLabel: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-muted-foreground">
        <b className="text-foreground">SS · señales de movimiento con fuerza</b> de la P(Up) del motor C, en el segundo en que se detectan con los datos
        de ese momento (fuerza 0-100: lo que recorre × lo brusco que es frente al ruido de antes; no genera órdenes)
        {refLabel && <> · al final, cuánto se movió el token Up de {refLabel} en esa misma ventana</>}
      </span>
      {STRENGTH_VARIANTS.map((v) => (
        <div key={v} className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold">
            {STRENGTH_LABEL[v]} <span className="font-normal text-muted-foreground">· {strength[v].length}</span>
          </span>
          {!strength[v].length ? (
            <span className="text-[11px] text-muted-foreground">Ningún movimiento con fuerza en este market.</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {strength[v].map((e) => {
                const up = e.dir === "up";
                return (
                  <span
                    key={`${e.time}${e.dir}`}
                    className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${up ? "border-buy/40 text-buy" : "border-sell/40 text-sell"}`}
                    title={`sorpresa ${e.z.toFixed(1)}σ frente al ruido previo`}
                  >
                    +{Math.round((e.time - start) / 1000)}s {up ? "▲" : "▼"} {(e.p * 100).toFixed(0)}% (desde {(e.from * 100).toFixed(0)}% en {e.seconds}s) ·{" "}
                    <b>{e.score}</b>
                    {e.refUpMove != null && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({refLabel ?? "ref"} Up {e.refUpMove >= 0 ? "+" : ""}
                        {(e.refUpMove * 100).toFixed(0)}¢)
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Market Up/Down del activo en vivo + revisión de los markets anteriores junto al flujo de Binance. El mismo panel sirve a Polymarket y a
 * Predict.fun (`venue`): mismos motores y misma gráfica; Predict no tiene compras reales.
 */
export function PolymarketPanel({ pm, flow, venue = "polymarket" }: { pm: PolymarketView; flow: OrderflowView; venue?: Venue }) {
  const v = VENUES[venue];
  const [selected, setSelected] = useState<string>(LIVE);
  const [fetched, setFetched] = useState<PmRecord | null>(null);
  const [fetching, setFetching] = useState(false);
  const [page, setPage] = useState(0);
  const fetchRecord = useFetchRecord(v.api);
  // Decisiones de los motores: el canal solo se abre con el drawer abierto
  const [enginesOpen, setEnginesOpen] = useState(false);
  const eng = useEngines(enginesOpen, v.enginesChannel);
  // compras reales del motor A o C (canal /ws/trading)
  const tr = useTrading(v.trading, v.tradingChannel, v.armApi);
  const source = useSource();
  const asset = useAsset();
  const ticker = ASSET_INFO[asset].ticker;
  const [now, setNow] = useState(() => exchangeClock.now());
  useEffect(() => {
    const id = setInterval(() => setNow(exchangeClock.now()), 500);
    return () => clearInterval(id);
  }, []);

  const history = useMemo(() => pm.history.slice().reverse(), [pm.history]); // reciente primero
  // la tabla sale de la API (todos los markets guardados); se vuelve a pedir cuando cierra uno nuevo
  const mk = useMarketRows(pm.history[pm.history.length - 1]?.market.slug ?? "", v.api);
  const isLive = selected === LIVE;
  // market elegido: de la memoria del canal si esta, o pedido a la API (los mas antiguos)
  const picked = isLive ? undefined : (history.find((r) => r.market.slug === selected) ?? (fetched?.market.slug === selected ? fetched : undefined));
  const select = (slug: string) => {
    setSelected(slug);
    if (slug === LIVE || pm.history.some((r) => r.market.slug === slug)) return;
    setFetching(true);
    void fetchRecord(slug)
      .then((r) => setFetched(r))
      .finally(() => setFetching(false));
  };

  // Registro mostrado: el de la historia, o el market en curso armado con datos en vivo.
  const view: PmRecord | null = useMemo(() => {
    if (!isLive) return picked ?? null;
    if (!pm.current) return null;
    const run = (e: { points: PmRecord["points"]; trades: PmSignal[] }) => ({ ...e, pnl: EMPTY_PNL });
    return {
      market: pm.current,
      points: pm.points,
      ...sliceFlow(pm.current, flow),
      trades: pm.trades,
      pnl: EMPTY_PNL,
      engines: { c: run(pm.engines.c) },
      complete: true,
      ...(pm.strength ? { strength: pm.strength } : {}),
      ...(pm.reference ? { ref: pm.reference } : {}),
    };
  }, [isLive, picked, pm.current, pm.points, pm.trades, pm.engines, pm.strength, pm.reference, flow]);

  // una serie por motor (A = points/trades del market; C en `engines`, ausente en markets antiguos)
  const series: EngineSeries[] = useMemo(() => {
    if (!view) return [];
    const src: Record<PmEngineId, { points: PmRecord["points"]; trades: PmSignal[] } | undefined> = {
      a: { points: view.points, trades: view.trades },
      c: view.engines?.c,
    };
    const slug = view.market.slug;
    // cada mercado tiene su canal de compras reales (los slugs de Predict y Polymarket coinciden, pero no se mezclan)
    const real = v.trading ? tr.trades.filter((t) => t.slug === slug && t.status === "matched") : [];
    return ENGINE_IDS.filter((id) => src[id]).map((id) => ({
      id,
      label: ENGINE_LABEL[id],
      desc: ENGINE_DESC[id],
      points: src[id]!.points,
      trades: src[id]!.trades,
      real: real.filter((t) => t.engine === id),
    }));
  }, [view, tr.trades, v.trading]);

  const totals = useMemo(
    () =>
      ENGINE_IDS.map((id) => {
        let invested = 0;
        let net = 0;
        let markets = 0;
        let wins = 0;
        for (const r of mk.rows) {
          const e = r.engines[id];
          if (e.net === null || e.invested <= 0) continue;
          invested += e.invested;
          net += e.net;
          markets++;
          if (e.net > 0) wins++;
        }
        return { id, invested, net, markets, wins };
      }),
    [mk.rows],
  );

  const pages = Math.max(1, Math.ceil(mk.rows.length / PAGE_SIZE));
  const curPage = Math.min(page, pages - 1);
  const pageRows = mk.rows.slice(curPage * PAGE_SIZE, (curPage + 1) * PAGE_SIZE);

  // motores con seccion en el grafico (ASSET_INFO.charts; todos si no se indica)
  const charts = ASSET_INFO[asset].charts;
  const chartSeries = useMemo(() => (charts ? series.filter((e) => charts.includes(e.id)) : series), [series, charts]);

  const m = view?.market ?? null;
  const last = view?.points[view.points.length - 1];
  // activos baratos (SOL): mas decimales en los precios
  const pxDec = (last?.chainlink ?? m?.priceToBeat ?? 1e4) < 1000 ? 3 : 2;
  const px = (v: number | null) => (v === null ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: pxDec, maximumFractionDigits: pxDec }));
  // Referencia para la diferencia con el price to beat: Chainlink ahora (en vivo) o el cierre oficial
  const ref = m ? (isLive ? (last?.chainlink ?? null) : (m.closePrice ?? last?.chainlink ?? null)) : null;
  const gap = m?.priceToBeat != null && ref !== null ? ref - m.priceToBeat : null;
  const left = m && isLive ? Math.max(0, m.end - now) : null;
  const mmss = left === null ? "" : `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <>
    <Panel
      id={`${asset}.${venue}`}
      title={
        <>
          {v.title(ticker)} <span className="font-medium text-muted-foreground">· motores con Binance {SOURCE_LABEL[source]}</span>
        </>
      }
      description={
        <>
          Market en curso y los últimos markets terminados. Selecciona uno (aquí o en el historial) para ver el precio de los tokens Up/Down
          con las señales de Binance marcadas, y el CVD y delta de esos 5 minutos.
        </>
      }
      actions={
        <>
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setEnginesOpen(true)}>
            Motores
          </Button>
          <LiveBadge label={v.badge} link={pm.link} upstream={pm.upstream} />
        </>
      }
      contentClassName="flex flex-col gap-4 p-4 sm:p-5"
    >
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          <Button size="sm" className="shrink-0 rounded-full" variant={isLive ? "default" : "outline"} onClick={() => select(LIVE)}>
            <span className="mr-1 size-1.5 rounded-full bg-buy" /> En vivo {pm.current ? fmtClockHM(pm.current.start) : ""}
          </Button>
          {history.map((r) => (
            <Button
              key={r.market.slug}
              size="sm"
              variant={selected === r.market.slug ? "default" : "outline"}
              onClick={() => select(r.market.slug)}
              className="shrink-0 rounded-full"
            >
              {fmtClockHM(r.market.start)}{" "}
              <span className={r.market.result === "up" ? "text-buy" : r.market.result === "down" ? "text-sell" : "text-muted-foreground"}>
                {r.market.result === "up" ? "▲" : r.market.result === "down" ? "▼" : "…"}
              </span>
            </Button>
          ))}
        </div>

        {!m || !view ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{isLive ? "Esperando el market en curso…" : fetching ? "Cargando market…" : "No se pudo cargar el market."}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-48">
                <div className="text-base font-semibold tracking-tight">{m.title || m.slug}</div>
                <div className="text-[11px] text-muted-foreground">
                  {fmtClockHM(m.start)} – {fmtClockHM(m.end)} (hora local)
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isLive ? (
                  <Badge variant="outline" className="h-7 rounded-full px-3 font-mono text-xs">
                    cierra en {mmss}
                  </Badge>
                ) : (
                  <>
                    <Mismatch m={m} />
                    <ResultBadge result={m.result} />
                  </>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-4 @6xl:grid-cols-8">
              <Stat label={v.chainlinkLabel(ticker)} className="text-chain">
                {px(last?.chainlink ?? null)}
              </Stat>
              <Stat label="Price to beat">{px(m.priceToBeat)}</Stat>
              {!isLive && <Stat label="Cierre">{px(m.closePrice)}</Stat>}
              <Stat label={isLive ? "Chainlink − to beat" : "Cierre − to beat"} className={cls(gap)}>
                {gap === null ? "–" : `${sign(gap)}${gap.toFixed(pxDec)} USD`}
              </Stat>
              <Stat label="P(Up) motor A" className="text-chain">
                {pct(last?.pModel ?? null)}
              </Stat>
              <Stat label="Flujo" className={cls(last?.flow ?? null)}>
                {last?.flow != null ? `${sign(last.flow)}${last.flow.toFixed(2)}` : "–"}
              </Stat>
              <Stat label="Up (bid/ask)" className="text-buy">
                {cents(last?.upBid ?? null)}/{cents(last?.upAsk ?? null)}
              </Stat>
              <Stat label="Down (bid/ask)" className="text-sell">
                {cents(last?.downBid ?? null)}/{cents(last?.downAsk ?? null)}
              </Stat>
            </div>

            {isLive && v.trading && <LiveTradingCard tr={tr} slug={m.slug} venue={venue} />}
            <div className="overflow-hidden rounded-xl border">
              <PolymarketChart
                market={m}
                points={view.points}
                bars={view.bars}
                cvd={view.cvd}
                signals={view.signals}
                engines={chartSeries}
                chainTitle={v.chainTitle}
                strength={view.strength}
                reference={view.ref}
              />
            </div>
            {view.strength && <StrengthList strength={view.strength} start={m.start} refLabel={view.ref?.label ?? null} />}
            {!isLive && (
              <p className="text-[11px] text-muted-foreground">
                Resultado en este market:{" "}
                {ENGINE_IDS.map((id) => {
                  const p = id === "a" ? view.pnl : view.engines?.[id]?.pnl;
                  if (!p) return null;
                  return (
                    <span key={id} className="mr-3">
                      {ENGINE_LABEL[id]} invertido {p.invested.toFixed(2)} · neto <span className={cls(p.net)}>{money(p.net)} USDC</span>
                      {p.roi !== null && <> ({sign(p.roi)}{(p.roi * 100).toFixed(1)}%)</>}
                    </span>
                  );
                })}
                {!view.complete && <span className="ml-2 text-warn">· datos incompletos: no se guarda en la base de datos</span>}
              </p>
            )}
            {isLive && pm.next && (
              <p className="text-[11px] text-muted-foreground">
                Siguiente: {pm.next.title || pm.next.slug} · empieza {fmtClockHM(pm.next.start)}
              </p>
            )}
          </>
        )}

    </Panel>

    <Panel
      id={`${asset}.${venue}.ops`}
      title={
        <>
          Operaciones del market <span className="font-medium text-muted-foreground">· {m ? (isLive ? "en vivo" : `${fmtClockHM(m.start)}–${fmtClockHM(m.end)}`) : "–"}</span>
        </>
      }
      description="Compras y ventas de los motores en el market elegido arriba (papel)."
      contentClassName="p-4 sm:p-5"
    >
      {m ? <TradesList engines={series} start={m.start} /> : <p className="text-[11px] text-muted-foreground">Sin market seleccionado.</p>}
    </Panel>

    <Panel
      id={`${asset}.${venue}.history`}
      title={
        <>
          Historial de markets <span className="font-medium text-muted-foreground">· {v.title(ticker)} · {SOURCE_LABEL[source]}</span>
        </>
      }
      description="Todos los markets guardados en la base de datos, con el resultado de papel de cada motor. Pulsa una fila para abrirla en el gráfico."
      actions={
        <Badge variant="outline" className="h-7 rounded-full px-3 font-mono text-xs">
          {mk.total}
        </Badge>
      }
      contentClassName="flex flex-col gap-4 p-4 sm:p-5"
    >
        {mk.error && <p className="text-[11px] text-warn">No se pudo leer la lista de markets del servidor ({mk.error}).</p>}
        {!mk.error && mk.rows.length === 0 && <p className="text-[11px] text-muted-foreground">Aún no hay markets guardados.</p>}
        {mk.rows.length > 0 && (
          <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            <span>
              {mk.total} markets guardados. Resultados de papel: A y C se ejecutan al precio del segundo de la señal (optimista). Con pocos markets no son estadísticamente concluyentes.
            </span>
            {totals.map((t) => (
              <span key={t.id}>
                <b className="text-foreground">{ENGINE_LABEL[t.id]}</b>: {t.markets} con operaciones · invertido {t.invested.toFixed(2)} USDC · neto{" "}
                <span className={cls(t.net)}>{money(t.net)} USDC</span>
                {t.invested > 0 && <> ({sign(t.net)}{((t.net / t.invested) * 100).toFixed(1)}%)</>} · ganadores {t.wins}/{t.markets}
              </span>
            ))}
          </div>
        )}
        {mk.rows.length > 0 && (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Price to beat</TableHead>
                  <TableHead className="text-right">Cierre</TableHead>
                  <TableHead className="text-right">Cambio</TableHead>
                  <TableHead>Resultado</TableHead>
                  <TableHead className="text-right">Delta footprint</TableHead>
                  <TableHead className="text-right">Δ CVD</TableHead>
                  <TableHead className="text-right">Señales</TableHead>
                  <TableHead className="text-right">Up inicio→fin</TableHead>
                  {ENGINE_IDS.map((id) => (
                    <TableHead key={id} className="text-right">
                      {id.toUpperCase()} ops · neto
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => (
                  <TableRow key={r.slug} onClick={() => select(r.slug)} className={`cursor-pointer ${selected === r.slug ? "bg-muted" : ""}`}>
                    <TableCell className="font-mono">
                      <span className="mr-1.5 text-muted-foreground">{fmtDayShort(r.start)}</span>
                      {fmtClockHM(r.start)}
                    </TableCell>
                    <TableCell className="text-right font-mono">{usd(r.priceToBeat)}</TableCell>
                    <TableCell className="text-right font-mono">{usd(r.closePrice)}</TableCell>
                    <TableCell className={`text-right font-mono ${cls(r.changePct)}`}>
                      {r.changePct === null ? "–" : `${sign(r.changePct)}${r.changePct.toFixed(3)}%`}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1">
                        <ResultBadge result={r.result} />
                        <Mismatch m={r} />
                      </span>
                    </TableCell>
                    <TableCell className={`text-right font-mono ${cls(r.delta)}`}>{sign(r.delta)}{r.delta.toFixed(2)}</TableCell>
                    <TableCell className={`text-right font-mono ${cls(r.cvdChange)}`}>{sign(r.cvdChange)}{r.cvdChange.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">
                      <span className="text-buy">▲{r.bull}</span> <span className="text-sell">▼{r.bear}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {cents(r.upStart)}→{cents(r.upEnd)}
                    </TableCell>
                    {ENGINE_IDS.map((id) => (
                      <TableCell key={id} className="text-right font-mono">
                        {r.engines[id].trades} · <span className={cls(r.engines[id].net)}>{money(r.engines[id].net)}</span>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
            <span>
              {curPage * PAGE_SIZE + 1}–{Math.min((curPage + 1) * PAGE_SIZE, mk.rows.length)} de {mk.rows.length}
            </span>
            <Button size="sm" variant="outline" className="rounded-full" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
              Más recientes
            </Button>
            <Button size="sm" variant="outline" className="rounded-full" disabled={curPage >= pages - 1} onClick={() => setPage(curPage + 1)}>
              Más antiguos
            </Button>
          </div>
        )}
    </Panel>
    <EnginesDrawer open={enginesOpen} onOpenChange={setEnginesOpen} eng={eng} rows={mk.rows} marketStart={pm.current?.start ?? 0} />
    </>
  );
}
