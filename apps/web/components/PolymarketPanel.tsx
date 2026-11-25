"use client";

import { useEffect, useMemo, useState } from "react";
import type { PmMarketRow, PmPnl, PmRecord, PmSignal } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exchangeClock } from "@/lib/exchangeClock";
import { fmtClockHM, fmtDayShort } from "@/lib/flow";
import type { OrderflowView } from "@/lib/useOrderflow";
import { useFetchRecord, useMarketRows } from "@/lib/useMarketRows";
import { sliceFlow, type PolymarketView } from "@/lib/usePolymarket";
import { LiveBadge } from "./LiveBadge";
import { PolymarketChart } from "./PolymarketChart";

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
    <span className="cursor-help text-yellow-500" title="El resultado oficial no coincide con apertura/cierre (ambos TWAP). Es un caso raro: revísalo en Polymarket.">
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
    <div className="flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${className}`}>{children}</span>
    </div>
  );
}

const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(0)}%`);
const money = (v: number | null) => (v === null ? "–" : `${sign(v)}${v.toFixed(2)}`);

/** Lista de compras / ventas que el motor senalo en el market mostrado. */
function TradesList({ trades, start }: { trades: PmSignal[]; start: number }) {
  if (!trades.length) return <p className="text-[11px] text-muted-foreground">El motor no senalo operaciones en este market.</p>;
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
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
          {trades.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-mono">+{Math.round((t.time - start) / 1000)}s</TableCell>
              <TableCell className={`font-semibold ${t.side === "up" ? "text-buy" : "text-sell"}`}>
                {t.action === "buy" ? "COMPRAR" : "VENDER"} {t.side === "up" ? "Up" : "Down"}
              </TableCell>
              <TableCell className="text-muted-foreground">{t.reason}</TableCell>
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

/** Market BTC Up/Down en vivo + revisión de los markets anteriores junto al flujo de Binance. */
export function PolymarketPanel({ pm, flow }: { pm: PolymarketView; flow: OrderflowView }) {
  const [selected, setSelected] = useState<string>(LIVE);
  const [fetched, setFetched] = useState<PmRecord | null>(null);
  const [fetching, setFetching] = useState(false);
  const [page, setPage] = useState(0);
  const fetchRecord = useFetchRecord();
  const [now, setNow] = useState(() => exchangeClock.now());
  useEffect(() => {
    const id = setInterval(() => setNow(exchangeClock.now()), 500);
    return () => clearInterval(id);
  }, []);

  const history = useMemo(() => pm.history.slice().reverse(), [pm.history]); // reciente primero
  // la tabla sale de la API (todos los markets guardados); se vuelve a pedir cuando cierra uno nuevo
  const mk = useMarketRows(pm.history[pm.history.length - 1]?.market.slug ?? "");
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
    return { market: pm.current, points: pm.points, ...sliceFlow(pm.current, flow), trades: pm.trades, pnl: EMPTY_PNL, complete: true };
  }, [isLive, picked, pm.current, pm.points, pm.trades, flow]);

  const total = useMemo(() => {
    let invested = 0;
    let net = 0;
    let markets = 0;
    let wins = 0;
    for (const r of mk.rows) {
      if (r.net === null || r.invested <= 0) continue;
      invested += r.invested;
      net += r.net;
      markets++;
      if (r.net > 0) wins++;
    }
    return { invested, net, markets, wins };
  }, [mk.rows]);

  const pages = Math.max(1, Math.ceil(mk.rows.length / PAGE_SIZE));
  const curPage = Math.min(page, pages - 1);
  const pageRows = mk.rows.slice(curPage * PAGE_SIZE, (curPage + 1) * PAGE_SIZE);

  const m = view?.market ?? null;
  const last = view?.points[view.points.length - 1];
  // Referencia para la diferencia con el price to beat: Chainlink ahora (en vivo) o el cierre oficial
  const ref = m ? (isLive ? (last?.chainlink ?? null) : (m.closePrice ?? last?.chainlink ?? null)) : null;
  const gap = m?.priceToBeat != null && ref !== null ? ref - m.priceToBeat : null;
  const left = m && isLive ? Math.max(0, m.end - now) : null;
  const mmss = left === null ? "" : `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-3">
        <CardTitle>Polymarket · BTC Up or Down 5m</CardTitle>
        <CardDescription>
          Market en curso y todos los markets guardados en la base de datos ({mk.total}). Selecciona uno para ver el precio de los
          tokens Up/Down con las señales de Binance marcadas, y el CVD y delta de esos 5 minutos.
        </CardDescription>
        <CardAction>
          <LiveBadge label="Polymarket" link={pm.link} upstream={pm.upstream} />
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <Button size="sm" variant={isLive ? "default" : "outline"} onClick={() => select(LIVE)}>
            <span className="mr-1 size-1.5 rounded-full bg-buy" /> En vivo {pm.current ? fmtClockHM(pm.current.start) : ""}
          </Button>
          {history.map((r) => (
            <Button
              key={r.market.slug}
              size="sm"
              variant={selected === r.market.slug ? "default" : "outline"}
              onClick={() => select(r.market.slug)}
              className="shrink-0"
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
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div className="min-w-48">
                <div className="text-sm font-medium">{m.title || m.slug}</div>
                <div className="text-[11px] text-muted-foreground">
                  {fmtClockHM(m.start)} – {fmtClockHM(m.end)} (hora local)
                </div>
              </div>
              <Stat label="Chainlink BTC/USD" className="text-violet-400">
                {last?.chainlink != null ? last.chainlink.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–"}
              </Stat>
              <Stat label="Price to beat">{usd(m.priceToBeat)}</Stat>
              {!isLive && <Stat label="Cierre">{usd(m.closePrice)}</Stat>}
              <Stat label={isLive ? "Chainlink − to beat" : "Cierre − to beat"} className={cls(gap)}>
                {gap === null ? "–" : `${sign(gap)}${gap.toFixed(2)} USD`}
              </Stat>
              <Stat label="P(Up) motor" className="text-violet-400">
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
              <div className="ml-auto flex items-center gap-2">
                {isLive ? (
                  <Badge variant="outline" className="font-mono">
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

            <div className="rounded-md border">
              <PolymarketChart market={m} points={view.points} bars={view.bars} cvd={view.cvd} signals={view.signals} trades={view.trades} />
            </div>
            <TradesList trades={view.trades} start={m.start} />
            {!isLive && (
              <p className="text-[11px] text-muted-foreground">
                Resultado del motor en este market: invertido {view.pnl.invested.toFixed(2)} · vendido {view.pnl.sold.toFixed(2)} · neto{" "}
                <span className={cls(view.pnl.net)}>{money(view.pnl.net)} USDC</span>
                {view.pnl.roi !== null && <> ({sign(view.pnl.roi)}{(view.pnl.roi * 100).toFixed(1)}%)</>}
                {!view.complete && <span className="ml-2 text-yellow-500">· datos incompletos: no se guarda en la base de datos</span>}
              </p>
            )}
            {isLive && pm.next && (
              <p className="text-[11px] text-muted-foreground">
                Siguiente: {pm.next.title || pm.next.slug} · empieza {fmtClockHM(pm.next.start)}
              </p>
            )}
          </>
        )}

        {mk.error && <p className="text-[11px] text-yellow-500">No se pudo leer la lista de markets del servidor ({mk.error}).</p>}
        {mk.rows.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Motor, {mk.total} markets guardados: {total.markets} con operaciones · invertido {total.invested.toFixed(2)} USDC · neto{" "}
            <span className={cls(total.net)}>{money(total.net)} USDC</span>
            {total.invested > 0 && <> ({sign(total.net)}{((total.net / total.invested) * 100).toFixed(1)}%)</>} · markets ganadores {total.wins}/{total.markets}.
            Resultados de papel (se asume seguir todas las señales con los precios reales); con pocos markets no son estadisticamente concluyentes.
          </p>
        )}
        {mk.rows.length > 0 && (
          <div className="rounded-md border">
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
                  <TableHead className="text-right">Motor</TableHead>
                  <TableHead className="text-right">Neto (USDC)</TableHead>
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
                    <TableCell className="text-right font-mono">{r.trades}</TableCell>
                    <TableCell className={`text-right font-mono ${cls(r.net)}`}>{money(r.net)}</TableCell>
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
            <Button size="sm" variant="outline" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
              Más recientes
            </Button>
            <Button size="sm" variant="outline" disabled={curPage >= pages - 1} onClick={() => setPage(curPage + 1)}>
              Más antiguos
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
