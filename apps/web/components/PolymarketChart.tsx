"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CvdPoint, FootprintBar, OrderflowSignal, PmMarket, PmPoint, PmSignal } from "@updown/protocol";
import { biasArrow, fmtClockHM, SIGNAL_INFO } from "@/lib/flow";
import { mid } from "@/lib/usePolymarket";

interface Props {
  market: PmMarket;
  points: PmPoint[];
  bars: FootprintBar[];
  cvd: CvdPoint[];
  signals: OrderflowSignal[];
  /** senales de compra/venta del motor */
  trades: PmSignal[];
  /** operaciones del motor B (sincronizado), para compararlas; se dibujan huecas */
  tradesB?: PmSignal[];
}

const PAD_L = 8;
const PAD_R = 40;
const SECTIONS = [
  { key: "prob", h: 190, title: "Probabilidad de Up: motor (violeta) vs mercado (blanco) · compras / ventas del motor" },
  { key: "price", h: 210, title: "Precio de los tokens Up / Down (¢) con señales" },
  { key: "bin", h: 170, title: "Precio Binance (USDT) con señales" },
  { key: "chain", h: 150, title: "Precio Chainlink (USD, fuente de Polymarket) con señales" },
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
export function PolymarketChart({ market, points, bars, cvd, signals, trades, tradesB = [] }: Props) {
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

  const layout = useMemo(() => {
    let y = 4;
    return SECTIONS.map((s) => {
      const top = y + 14;
      y += s.h + GAP;
      return { ...s, top, bottom: top + s.h - 14 };
    });
  }, []);
  const totalH = layout[layout.length - 1]!.bottom + 22;

  const data = useMemo(() => {
    const up = points.map((p) => ({ time: p.time, v: mid(p.upBid, p.upAsk) })).filter((p): p is { time: number; v: number } => p.v !== null);
    const down = points.map((p) => ({ time: p.time, v: mid(p.downBid, p.downAsk) })).filter((p): p is { time: number; v: number } => p.v !== null);
    // Escala ajustada al rango real del market (con margen), siempre dentro de 0-1.
    const [lo, hi] = extent([...up, ...down].map((p) => p.v), 0.1, 0.1);
    const pLo = Math.max(0, lo);
    const pHi = Math.min(1, hi);

    const eng = points.filter((p) => p.pModel !== null).map((p) => ({ time: p.time, v: p.pModel! }));
    const mkt = points
      .map((p) => {
        const u = mid(p.upBid, p.upAsk);
        const d = mid(p.downBid, p.downAsk);
        return { time: p.time, v: u !== null && d !== null ? (u + 1 - d) / 2 : u !== null ? u : d !== null ? 1 - d : null };
      })
      .filter((p): p is { time: number; v: number } => p.v !== null);
    const [qLo, qHi] = extent([...eng, ...mkt].map((p) => p.v), 0.1, 0.2);
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
    return { eng, mkt, prLo, prHi, up, down, pLo, pHi, bin, bLo, bHi, chain, kLo, kHi, cv, cLo, cHi, dMax };
  }, [points, cvd, bars, signals, priceToBeat]);

  type L = (typeof layout)[number];
  const [sProb, sPrice, sBin, sChain, sCvd, sDelta] = layout as [L, L, L, L, L, L];
  const yProb = (v: number) => sProb.bottom - ((v - data.prLo) / (data.prHi - data.prLo)) * (sProb.bottom - sProb.top);
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
            <line x1={xOf(t)} x2={xOf(t)} y1={sProb.top} y2={sDelta.bottom} className="stroke-border" strokeWidth={0.5} />
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
            y1={sProb.top}
            y2={sDelta.bottom}
            className={s.bias === "bullish" ? "stroke-buy" : "stroke-sell"}
            strokeWidth={0.8}
            strokeDasharray="2 3"
            opacity={0.35}
          />
        ))}

        {/* Probabilidad de Up: motor vs mercado, y compras / ventas del motor */}
        {[0.1, 0.25, 0.5, 0.75, 0.9].filter((v) => v >= data.prLo && v <= data.prHi).map((v) => (
          <g key={`q${v}`}>
            <line x1={PAD_L} x2={PAD_L + plotW} y1={yProb(v)} y2={yProb(v)} className="stroke-border" strokeWidth={0.4} strokeDasharray={v === 0.5 ? "4 3" : undefined} />
            <text x={PAD_L + plotW + 4} y={yProb(v) + 3} className="fill-muted-foreground text-[10px]">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <path d={path(data.mkt.map((p) => [xOf(p.time), yProb(p.v)]))} className="fill-none stroke-foreground" strokeWidth={1.2} opacity={0.7} />
        <path d={path(data.eng.map((p) => [xOf(p.time), yProb(p.v)]))} className="fill-none stroke-violet-400" strokeWidth={1.8} />
        {trades.map((t) => {
          // Up-equivalente: comprar/vender Down a q equivale a 1-q en la escala de Up
          const v = t.side === "up" ? t.price : 1 - t.price;
          const x = xOf(t.time);
          const y = yProb(Math.min(data.prHi, Math.max(data.prLo, v)));
          const buy = t.action === "buy";
          const up = t.side === "up";
          return (
            <g key={t.id} className={up ? "fill-buy stroke-buy" : "fill-sell stroke-sell"}>
              <title>{`${buy ? "COMPRAR" : "VENDER"} ${up ? "Up" : "Down"} a ${(t.price * 100).toFixed(0)}¢ (${t.reason}) · ${fmtClockHM(t.time)} · ${t.shares} tokens · ${t.amount} USDC · P motor ${(t.pSide * 100).toFixed(0)}% · edge ${(t.edge * 100).toFixed(1)}¢ · faltaban ${t.tau.toFixed(0)}s`}</title>
              <line x1={x} x2={x} y1={sProb.top} y2={sDelta.bottom} strokeWidth={1} strokeDasharray="1 3" opacity={0.5} />
              {buy ? <path d={`M${x},${y - 8}L${x - 6},${y + 4}L${x + 6},${y + 4}Z`} className="stroke-background" strokeWidth={1} /> : <path d={`M${x},${y + 8}L${x - 6},${y - 4}L${x + 6},${y - 4}Z`} className="stroke-background" strokeWidth={1} />}
              <text x={x} y={buy ? y + 16 : y - 11} textAnchor="middle" className="stroke-none text-[9px] font-bold">
                {`${buy ? "C" : "V"} ${up ? "Up" : "Dn"} ${(t.price * 100).toFixed(0)}¢`}
              </text>
            </g>
          );
        })}

        {/* Motor B (sincronizado): marcas huecas con la etiqueta al otro lado que las de A */}
        {tradesB.map((t) => {
          const v = t.side === "up" ? t.price : 1 - t.price;
          const x = xOf(t.time);
          const y = yProb(Math.min(data.prHi, Math.max(data.prLo, v)));
          const buy = t.action === "buy";
          const up = t.side === "up";
          return (
            <g key={`B${t.id}`} className={up ? "stroke-buy fill-buy" : "stroke-sell fill-sell"}>
              <title>{`Motor B · ${buy ? "COMPRAR" : "VENDER"} ${up ? "Up" : "Down"} a ${(t.price * 100).toFixed(0)}¢ (${t.reason}) · ${fmtClockHM(t.time)} · ${t.shares} tokens · ${t.amount} USDC · edge ${(t.edge * 100).toFixed(1)}¢`}</title>
              {buy ? <path d={`M${x},${y - 8}L${x - 6},${y + 4}L${x + 6},${y + 4}Z`} className="fill-none" strokeWidth={1.4} /> : <path d={`M${x},${y + 8}L${x - 6},${y - 4}L${x + 6},${y - 4}Z`} className="fill-none" strokeWidth={1.4} />}
              <text x={x} y={buy ? y - 11 : y + 16} textAnchor="middle" className="stroke-none text-[9px] font-bold opacity-80">
                {`B ${buy ? "C" : "V"} ${up ? "Up" : "Dn"} ${(t.price * 100).toFixed(0)}¢`}
              </text>
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
