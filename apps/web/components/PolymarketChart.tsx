"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CvdPoint, FootprintBar, LiveTrade, OrderflowSignal, PmEngineId, PmMarket, PmOrder, PmPoint, PmSignal } from "@updown/protocol";
import { biasArrow, fmtClockHM, SIGNAL_INFO } from "@/lib/flow";
import { mid } from "@/lib/usePolymarket";
import { VENUES } from "@/lib/venue";

/** Probabilidad y operaciones de un motor (cada uno con su propia seccion) */
export interface EngineSeries {
  id: PmEngineId;
  label: string;
  desc: string;
  points: PmPoint[];
  trades: PmSignal[];
  /** motor E: ordenes en reposo (cada una es un tramo horizontal en su precio, de que entra al libro a que se ejecuta o cancela) */
  orders?: PmOrder[];
  /** operaciones REALES ejecutadas siguiendo a este motor (A, C o D, market en curso) */
  real?: LiveTrade[];
}

interface Props {
  market: PmMarket;
  /** muestras del market (las del motor A): precios de los tokens y Chainlink */
  points: PmPoint[];
  bars: FootprintBar[];
  cvd: CvdPoint[];
  signals: OrderflowSignal[];
  /** motores A, C, D y E: una seccion de probabilidad + operaciones por motor */
  engines: EngineSeries[];
  /** titulo de la franja de Chainlink (cambia con el mercado: TWAP en Polymarket, precio puntual en Predict) */
  chainTitle?: string;
}

const PAD_L = 8;
const PAD_R = 40;
const PROB_H = 150;
const SECTIONS = [
  { key: "price", h: 210, title: "Precio de los tokens Up / Down (¢) con señales" },
  { key: "bin", h: 170, title: "Precio Binance (USDT) con señales" },
  { key: "chain", h: 150, title: VENUES.polymarket.chainTitle },
  { key: "cvd", h: 80, title: "CVD (Binance, desde el inicio)" },
  { key: "delta", h: 60, title: "Delta por barra footprint" },
] as const;
const GAP = 18;

/** Rango [min,max] con margen; si es plano abre un rango minimo. */
function extent(vals: number[], pad: number, minSpan: number): [number, number] {
  if (!vals.length) return [0, 1];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < minSpan) {
    const c = (hi + lo) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

const nearest = <T extends { time: number }>(arr: T[], t: number): T | null =>
  arr.reduce<T | null>((best, p) => (!best || Math.abs(p.time - t) < Math.abs(best.time - t) ? p : best), null);

const fmtCents = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(0)}¢`);

/**
 * Revisión de un market: precio de los tokens Up y Down con las señales de orderflow marcadas encima,
 * más CVD y delta por barra footprint, todo sobre el mismo eje de tiempo (la ventana de 5 min).
 * SVG: son pocos puntos (≤ 300).
 */
export function PolymarketChart({ market, points, bars, cvd, signals, engines, chainTitle }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { start, end, priceToBeat } = market;
  const plotW = Math.max(100, width - PAD_L - PAD_R);
  const xOf = (t: number) => PAD_L + ((t - start) / (end - start)) * plotW;

  const engineKeys = engines.map((e) => e.id).join(",");
  const layout = useMemo(() => {
    let y = 4;
    const probs = engines.map((e) => ({ key: `prob-${e.id}`, h: PROB_H, title: `${e.label} (${e.desc}) · P(Up) del motor (violeta) vs mercado (blanco) · compras / ventas` }));
    return [...probs, ...SECTIONS.map((s) => (s.key === "chain" && chainTitle ? { ...s, title: chainTitle } : s))].map((s) => {
      const top = y + 14;
      y += s.h + GAP;
      return { ...s, top, bottom: top + s.h - 14 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineKeys, chainTitle]);
  const totalH = layout[layout.length - 1]!.bottom + 22;

  const data = useMemo(() => {
    const up = points.map((p) => ({ time: p.time, v: mid(p.upBid, p.upAsk) })).filter((p): p is { time: number; v: number } => p.v !== null);
    const down = points.map((p) => ({ time: p.time, v: mid(p.downBid, p.downAsk) })).filter((p): p is { time: number; v: number } => p.v !== null);
    // Escala ajustada al rango real del market (con margen), siempre dentro de 0-1.
    const [lo, hi] = extent([...up, ...down].map((p) => p.v), 0.1, 0.1);
    const pLo = Math.max(0, lo);
    const pHi = Math.min(1, hi);

    // probabilidad de cada motor (con sus propias muestras) frente a la del mercado; misma escala para compararlos
    const probs = engines.map((e) => {
      const eng = e.points.filter((p) => p.pModel !== null).map((p) => ({ time: p.time, v: p.pModel! }));
      const mkt = e.points
        .map((p) => {
          const u = mid(p.upBid, p.upAsk);
          const d = mid(p.downBid, p.downAsk);
          return { time: p.time, v: u !== null && d !== null ? (u + 1 - d) / 2 : u !== null ? u : d !== null ? 1 - d : null };
        })
        .filter((p): p is { time: number; v: number } => p.v !== null);
      return { id: e.id, eng, mkt, trades: e.trades, real: e.real ?? [], orders: e.orders ?? [], lastT: e.points[e.points.length - 1]?.time ?? end };
    });
    const [qLo, qHi] = extent(probs.flatMap((pr) => [...pr.eng, ...pr.mkt].map((p) => p.v)), 0.1, 0.2);
    const prLo = Math.max(0, qLo);
    const prHi = Math.min(1, qHi);

    const bin = cvd.filter((p) => p.price > 0);
    const [bLo, bHi] = extent(
      [...bin.map((p) => p.price), ...signals.flatMap((sg) => [sg.priceLo, sg.priceHi])].filter((v) => v > 0),
      0.08,
      5,
    );

    const chain = points.filter((p) => p.chainlink !== null).map((p) => ({ time: p.time, v: p.chainlink! }));
    const [kLo, kHi] = extent([...chain.map((p) => p.v), ...(priceToBeat !== null ? [priceToBeat] : [])], 0.1, 5);

    const base = cvd[0]?.cvd ?? 0;
    const cv = cvd.map((p) => [p.time, p.cvd - base] as const);
    const [cLo, cHi] = extent([0, ...cv.map((p) => p[1])], 0.1, 1);
    const dMax = Math.max(0.001, ...bars.map((b) => Math.abs(b.delta)));
    return { probs, prLo, prHi, up, down, pLo, pHi, bin, bLo, bHi, chain, kLo, kHi, cv, cLo, cHi, dMax };
  }, [points, cvd, bars, signals, priceToBeat, engines, end]);

  type L = (typeof layout)[number];
  const probSecs = layout.slice(0, engines.length);
  const [sPrice, sBin, sChain, sCvd, sDelta] = layout.slice(engines.length) as [L, L, L, L, L];
  const sFirst = layout[0]!;
  const yProbIn = (sec: L) => (v: number) => sec.bottom - ((v - data.prLo) / (data.prHi - data.prLo)) * (sec.bottom - sec.top);
  const yPrice = (v: number) => sPrice.bottom - ((v - data.pLo) / (data.pHi - data.pLo)) * (sPrice.bottom - sPrice.top);
  const yBin = (v: number) => sBin.bottom - ((v - data.bLo) / (data.bHi - data.bLo)) * (sBin.bottom - sBin.top);
  const yChain = (v: number) => sChain.bottom - ((v - data.kLo) / (data.kHi - data.kLo)) * (sChain.bottom - sChain.top);
  const yCvd = (v: number) => sCvd.bottom - ((v - data.cLo) / (data.cHi - data.cLo)) * (sCvd.bottom - sCvd.top);
  const yDeltaMid = (sDelta.top + sDelta.bottom) / 2;
  const yDelta = (v: number) => yDeltaMid - (v / data.dMax) * ((sDelta.bottom - sDelta.top) / 2);

  // Marcas del eje de precio: cada 5¢ o 10¢ segun el rango
  const span = data.pHi - data.pLo;
  const step = span > 0.5 ? 0.1 : span > 0.2 ? 0.05 : 0.02;
  const priceTicks: number[] = [];
  for (let v = Math.ceil(data.pLo / step) * step; v <= data.pHi + 1e-9; v += step) priceTicks.push(Number(v.toFixed(4)));

  // Eje de tiempo: una marca por minuto
  const ticks: number[] = [];
  for (let t = start; t <= end; t += 60_000) ticks.push(t);

  // Cada señal se ancla al precio del token Up en el instante en que se detectó (el que haya más cerca, <= 15 s)
  const marks = useMemo(
    () =>
      signals.map((s) => {
        const p = nearest(data.up, s.time);
        return { s, v: p && Math.abs(p.time - s.time) <= 15_000 ? p.v : null };
      }),
    [signals, data.up],
  );

  const hovered = hover === null ? null : nearest(points, hover);

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg
        width={width}
        height={totalH}
        className="block"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = (e.clientX - r.left - PAD_L) / plotW;
          setHover(f >= 0 && f <= 1 ? start + f * (end - start) : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* rejilla vertical + etiquetas de tiempo */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xOf(t)} x2={xOf(t)} y1={sFirst.top} y2={sDelta.bottom} className="stroke-border" strokeWidth={0.5} />
            <text x={xOf(t)} y={totalH - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {fmtClockHM(t)}
            </text>
          </g>
        ))}

        {layout.map((s) => (
          <g key={s.key}>
            <text x={PAD_L} y={s.top - 4} className="fill-muted-foreground text-[10px]">
              {s.title}
            </text>
            <rect x={PAD_L} y={s.top} width={plotW} height={s.bottom - s.top} className="fill-none stroke-border" strokeWidth={0.5} />
          </g>
        ))}

        {/* Línea vertical tenue en cada señal, para leerla contra CVD y delta */}
        {marks.map(({ s }) => (
          <line
            key={`v${s.id}`}
            x1={xOf(s.time)}
            x2={xOf(s.time)}
            y1={sFirst.top}
            y2={sDelta.bottom}
            className={s.bias === "bullish" ? "stroke-buy" : "stroke-sell"}
            strokeWidth={0.8}
            strokeDasharray="2 3"
            opacity={0.35}
          />
        ))}

        {/* Una seccion por motor: su P(Up) frente a la del mercado y sus compras / ventas */}
        {data.probs.map((pr, i) => {
          const sec = probSecs[i]!;
          const yProb = yProbIn(sec);
          return (
            <g key={`prob-${pr.id}`}>
              {[0.1, 0.25, 0.5, 0.75, 0.9].filter((v) => v >= data.prLo && v <= data.prHi).map((v) => (
                <g key={`q${v}`}>
                  <line x1={PAD_L} x2={PAD_L + plotW} y1={yProb(v)} y2={yProb(v)} className="stroke-border" strokeWidth={0.4} strokeDasharray={v === 0.5 ? "4 3" : undefined} />
                  <text x={PAD_L + plotW + 4} y={yProb(v) + 3} className="fill-muted-foreground text-[10px]">
                    {Math.round(v * 100)}%
                  </text>
                </g>
              ))}
              <path d={path(pr.mkt.map((p) => [xOf(p.time), yProb(p.v)]))} className="fill-none stroke-foreground" strokeWidth={1.2} opacity={0.7} />
              <path d={path(pr.eng.map((p) => [xOf(p.time), yProb(p.v)]))} className="fill-none stroke-violet-400" strokeWidth={1.8} />
              {/* compras/ventas reales: circulo hueco donde se ejecuto, unido a la señal (distancia en tiempo y precio) */}
              {pr.real.map((t) => {
                if (t.avgPrice === null || t.respondedAt === null) return null;
                const upEq = (p: number) => Math.min(data.prHi, Math.max(data.prLo, t.side === "up" ? p : 1 - p));
                const x0 = xOf(t.signalTime);
                const y0 = yProb(upEq(t.signalPrice));
                const x = xOf(t.respondedAt);
                const y = yProb(upEq(t.avgPrice));
                return (
                  <g key={`real-${t.signalId}`} className="stroke-yellow-400">
                    <title>{`REAL: ${t.action === "buy" ? "compra" : "venta"} ${t.side === "up" ? "Up" : "Down"} ${t.filledShares.toFixed(2)} tokens a ${(t.avgPrice * 100).toFixed(1)}¢ (señal ${(t.signalPrice * 100).toFixed(1)}¢) · ${t.respondedAt - t.signalTime} ms desde la señal · orden ${t.latencyMs ?? "–"} ms`}</title>
                    <line x1={x0} y1={y0} x2={x} y2={y} strokeWidth={1.2} strokeDasharray="2 2" />
                    <circle cx={x} cy={y} r={6} className="fill-none" strokeWidth={2} />
                    <text x={x + 8} y={y - 6} className="fill-yellow-400 stroke-none text-[9px] font-bold">
                      REAL {(t.avgPrice * 100).toFixed(0)}¢
                    </text>
                  </g>
                );
              })}
              {/* motor E: ordenes en reposo (tramo en su precio Up-equivalente; continuo = ejecutada, discontinuo = cancelada) */}
              {pr.orders.map((o) => {
                const v = o.side === "up" ? o.price : 1 - o.price;
                if (v < data.prLo || v > data.prHi) return null;
                const t0 = Math.max(start, o.liveAt);
                const t1 = Math.min(end, o.status === "filled" ? (o.filledAt ?? o.liveAt) : (o.cancelAt ?? pr.lastT));
                if (o.status === "pending" || t1 < t0) return null;
                const y = yProb(v);
                return (
                  <line
                    key={o.id}
                    x1={xOf(t0)}
                    x2={Math.max(xOf(t0) + 1.5, xOf(t1))}
                    y1={y}
                    y2={y}
                    className={o.side === "up" ? "stroke-buy" : "stroke-sell"}
                    strokeWidth={o.status === "filled" ? 2.5 : 1.5}
                    strokeDasharray={o.status === "cancelled" ? "3 2" : undefined}
                    opacity={o.action === "buy" ? 0.85 : 0.55}
                  >
                    <title>{`Orden ${o.action === "buy" ? "de compra" : "de venta"} ${o.side === "up" ? "Up" : "Down"} a ${(o.price * 100).toFixed(0)}¢ · ${o.shares} tokens · cola por delante al entrar ${o.queueAhead.toFixed(0)} · ${o.status === "filled" ? "ejecutada" : o.status === "cancelled" ? `cancelada (${o.cancelReason ?? "–"})` : "en el libro"}${o.filledShares > 0 && o.status !== "filled" ? ` · ejecutados ${o.filledShares}` : ""}`}</title>
                  </line>
                );
              })}
              {pr.trades.map((t) => {
                // Up-equivalente: comprar/vender Down a q equivale a 1-q en la escala de Up
                const upEq = (p: number) => Math.min(data.prHi, Math.max(data.prLo, t.side === "up" ? p : 1 - p));
                // D y E: el marcador va donde se ejecuto (precio y momento), unido a la decision si fue taker
                const x = xOf(t.execTime ?? t.time);
                const y = yProb(upEq(t.price));
                const buy = t.action === "buy";
                const up = t.side === "up";
                const showSignal = t.signalPrice !== undefined && !t.maker && t.execTime !== undefined;
                return (
                  <g key={t.id} className={up ? "fill-buy stroke-buy" : "fill-sell stroke-sell"}>
                    <title>{`${buy ? "COMPRAR" : "VENDER"} ${up ? "Up" : "Down"} a ${(t.price * 100).toFixed(0)}¢ (${t.reason}${t.maker ? ", maker" : ""}) · ${fmtClockHM(t.time)}${showSignal ? ` · al decidir ${(t.signalPrice! * 100).toFixed(0)}¢, ejecutada ${((t.execTime! - t.time) / 1000).toFixed(1)} s después` : ""}${t.limit !== undefined ? ` · límite ${(t.limit * 100).toFixed(0)}¢` : ""} · ${t.shares} tokens · ${t.amount} USDC · P motor ${(t.pSide * 100).toFixed(0)}% · edge ${(t.edge * 100).toFixed(1)}¢ · faltaban ${t.tau.toFixed(0)}s`}</title>
                    <line x1={x} x2={x} y1={sec.top} y2={sec.bottom} strokeWidth={1} strokeDasharray="1 3" opacity={0.5} />
                    {showSignal && <line x1={xOf(t.time)} y1={yProb(upEq(t.signalPrice!))} x2={x} y2={y} strokeWidth={1} strokeDasharray="2 2" opacity={0.8} />}
                    {buy ? <path d={`M${x},${y - 8}L${x - 6},${y + 4}L${x + 6},${y + 4}Z`} className="stroke-background" strokeWidth={1} /> : <path d={`M${x},${y + 8}L${x - 6},${y - 4}L${x + 6},${y - 4}Z`} className="stroke-background" strokeWidth={1} />}
                    <text x={x} y={buy ? y + 16 : y - 11} textAnchor="middle" className="stroke-none text-[9px] font-bold">
                      {`${buy ? "C" : "V"} ${up ? "Up" : "Dn"} ${(t.price * 100).toFixed(0)}¢`}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Precio de los tokens */}
        {priceTicks.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={PAD_L + plotW} y1={yPrice(v)} y2={yPrice(v)} className="stroke-border" strokeWidth={0.4} strokeDasharray={v === 0.5 ? "4 3" : undefined} opacity={v === 0.5 ? 1 : 0.6} />
            <text x={PAD_L + plotW + 4} y={yPrice(v) + 3} className="fill-muted-foreground text-[10px]">
              {Math.round(v * 100)}¢
            </text>
          </g>
        ))}
        <path d={path(data.down.map((p) => [xOf(p.time), yPrice(p.v)]))} className="fill-none stroke-sell" strokeWidth={1.4} opacity={0.75} />
        <path d={path(data.up.map((p) => [xOf(p.time), yPrice(p.v)]))} className="fill-none stroke-buy" strokeWidth={1.8} />

        {/* Señales de orderflow sobre el precio del token Up */}
        {marks.map(({ s, v }) => {
          if (v === null) return null;
          const x = xOf(s.time);
          const y = yPrice(v);
          const bull = s.bias === "bullish";
          return (
            <g key={s.id} className={bull ? "fill-buy" : "fill-sell"}>
              <title>{`${SIGNAL_INFO[s.type].label} ${bull ? "alcista" : "bajista"} · ${fmtClockHM(s.time)} · Up ${fmtCents(v)}`}</title>
              <circle cx={x} cy={y} r={3.5} className="stroke-background" strokeWidth={1} />
              <text x={x} y={bull ? y + 15 : y - 9} textAnchor="middle" className="text-[10px] font-bold">
                {biasArrow(s.bias)}
              </text>
              <text x={x} y={bull ? y + 25 : y - 18} textAnchor="middle" className="text-[8px] opacity-90">
                {SIGNAL_INFO[s.type].short}
              </text>
            </g>
          );
        })}

        {/* Precio Binance + señales (rango de la zona y marca) */}
        <path d={path(data.bin.map((p) => [xOf(p.time), yBin(p.price)]))} className="fill-none stroke-yellow-500" strokeWidth={1.4} />
        <text x={PAD_L + plotW + 4} y={sBin.top + 8} className="fill-muted-foreground text-[10px]">
          {data.bHi.toFixed(0)}
        </text>
        <text x={PAD_L + plotW + 4} y={sBin.bottom} className="fill-muted-foreground text-[10px]">
          {data.bLo.toFixed(0)}
        </text>
        {signals.map((sg) => {
          const x = xOf(sg.time);
          const yHi = yBin(sg.priceHi);
          const yLo = yBin(sg.priceLo);
          const yMid = (yHi + yLo) / 2;
          if (yMid < sBin.top || yMid > sBin.bottom) return null;
          const bull = sg.bias === "bullish";
          return (
            <g key={`b${sg.id}`} className={bull ? "fill-buy stroke-buy" : "fill-sell stroke-sell"}>
              <title>{`${SIGNAL_INFO[sg.type].label} ${bull ? "alcista" : "bajista"} · ${fmtClockHM(sg.time)} · ${sg.priceLo.toFixed(2)}–${sg.priceHi.toFixed(2)}`}</title>
              <line x1={x} x2={x} y1={yHi} y2={yLo} strokeWidth={3} opacity={0.5} />
              <circle cx={x} cy={yMid} r={3.5} className="stroke-background" strokeWidth={1} />
              <text x={x} y={bull ? yMid + 15 : yMid - 9} textAnchor="middle" className="stroke-none text-[10px] font-bold">
                {biasArrow(sg.bias)}
              </text>
              <text x={x} y={bull ? yMid + 25 : yMid - 18} textAnchor="middle" className="stroke-none text-[8px] opacity-90">
                {SIGNAL_INFO[sg.type].short}
              </text>
            </g>
          );
        })}

        {/* Precio Chainlink + señales ancladas a su precio en el instante de la señal */}
        <path d={path(data.chain.map((p) => [xOf(p.time), yChain(p.v)]))} className="fill-none stroke-violet-400" strokeWidth={1.5} />
        <text x={PAD_L + plotW + 4} y={sChain.top + 8} className="fill-muted-foreground text-[10px]">
          {data.kHi.toFixed(0)}
        </text>
        <text x={PAD_L + plotW + 4} y={sChain.bottom} className="fill-muted-foreground text-[10px]">
          {data.kLo.toFixed(0)}
        </text>
        {priceToBeat !== null && (
          <g>
            <line x1={PAD_L} x2={PAD_L + plotW} y1={yChain(priceToBeat)} y2={yChain(priceToBeat)} className="stroke-foreground" strokeDasharray="5 4" strokeWidth={1} />
            <text x={PAD_L + plotW + 4} y={yChain(priceToBeat) + 3} className="fill-foreground text-[10px]">
              to beat
            </text>
          </g>
        )}
        {market.closePrice !== null && (
          <text x={PAD_L + plotW + 4} y={yChain(market.closePrice) + 3} className={market.result === "up" ? "fill-buy text-[10px]" : "fill-sell text-[10px]"}>
            cierre
          </text>
        )}
        {signals.map((sg) => {
          const pt = nearest(data.chain, sg.time);
          if (!pt || Math.abs(pt.time - sg.time) > 15_000) return null;
          const x = xOf(sg.time);
          const y = yChain(pt.v);
          const bull = sg.bias === "bullish";
          return (
            <g key={`c${sg.id}`} className={bull ? "fill-buy" : "fill-sell"}>
              <title>{`${SIGNAL_INFO[sg.type].label} ${bull ? "alcista" : "bajista"} · ${fmtClockHM(sg.time)} · Chainlink ${pt.v.toFixed(2)}`}</title>
              <circle cx={x} cy={y} r={3.5} className="stroke-background" strokeWidth={1} />
              <text x={x} y={bull ? y + 15 : y - 9} textAnchor="middle" className="text-[10px] font-bold">
                {biasArrow(sg.bias)}
              </text>
              <text x={x} y={bull ? y + 25 : y - 18} textAnchor="middle" className="text-[8px] opacity-90">
                {SIGNAL_INFO[sg.type].short}
              </text>
            </g>
          );
        })}

        {/* CVD */}
        <line x1={PAD_L} x2={PAD_L + plotW} y1={yCvd(0)} y2={yCvd(0)} className="stroke-border" strokeDasharray="3 3" strokeWidth={0.8} />
        <path d={path(data.cv.map(([t, v]) => [xOf(t), yCvd(v)]))} className="fill-none stroke-sky-400" strokeWidth={1.4} />
        <text x={PAD_L + plotW + 4} y={sCvd.top + 8} className="fill-muted-foreground text-[10px]">
          {data.cHi.toFixed(1)}
        </text>
        <text x={PAD_L + plotW + 4} y={sCvd.bottom} className="fill-muted-foreground text-[10px]">
          {data.cLo.toFixed(1)}
        </text>

        {/* Delta por barra */}
        <line x1={PAD_L} x2={PAD_L + plotW} y1={yDeltaMid} y2={yDeltaMid} className="stroke-border" strokeWidth={0.8} />
        {bars.map((b) => {
          const x0 = xOf(b.start) + 1;
          const x1 = xOf(Math.min(end, b.start + 60_000)) - 1;
          const y = yDelta(b.delta);
          return (
            <g key={b.start} className={b.delta >= 0 ? "fill-buy" : "fill-sell"}>
              <title>{`delta ${b.delta.toFixed(2)} · vol ${b.volume.toFixed(2)}${b.closed ? "" : " (en formación)"}`}</title>
              <rect x={x0} y={Math.min(y, yDeltaMid)} width={Math.max(1, x1 - x0)} height={Math.abs(y - yDeltaMid)} opacity={b.closed ? 0.85 : 0.45} />
            </g>
          );
        })}

        {/* Cursor */}
        {hover !== null && <line x1={xOf(hover)} x2={xOf(hover)} y1={sPrice.top} y2={sDelta.bottom} className="stroke-foreground" strokeWidth={0.6} opacity={0.5} />}
      </svg>

      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 rounded border bg-popover/95 px-2 py-1 text-[11px] leading-tight shadow"
          style={{ left: Math.min(width - 170, Math.max(0, xOf(hover) + 10)) }}
        >
          <div className="font-mono text-muted-foreground">{new Date(hovered.time).toLocaleTimeString("es", { hour12: false })}</div>
          {hovered.chainlink !== null && (
            <div className="text-violet-400">
              Chainlink <b className="font-mono">{hovered.chainlink.toFixed(2)}</b>
            </div>
          )}
          <div className="text-buy">
            Up <b className="font-mono">{fmtCents(hovered.upBid)} / {fmtCents(hovered.upAsk)}</b>
          </div>
          <div className="text-sell">
            Down <b className="font-mono">{fmtCents(hovered.downBid)} / {fmtCents(hovered.downAsk)}</b>
          </div>
        </div>
      )}

      <p className="px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="text-buy">━</span> token Up · <span className="text-sell">━</span> token Down · <span className="text-yellow-500">━</span> Binance · <span className="text-violet-400">━</span> Chainlink (┅ price to beat) · punto = señal (en Binance, en su zona de precio; en los tokens, anclada al precio de Up)
        (<b className="text-buy">▲ alcista</b> / <b className="text-sell">▼ bajista</b>; IMB · ABS · AGOT · DIV)
      </p>
    </div>
  );
}
