"use client";

import { useEffect, useRef } from "react";
import type { AggTrade, DepthColumn, OrderflowSignal } from "@updown/protocol";
import { chartMono } from "@/lib/chartFont";
import { attachViewInteractions } from "@/lib/chartInteractions";
import type { ChartView } from "@/lib/chartView";
import { BUY_RGB, SELL_RGB, SIGNAL_INFO, biasArrow, biasRgb, fmtClockHMS } from "@/lib/flow";
import { BUY_LUT, SELL_LUT } from "@/lib/heatmapPalette";

export interface ChartLayers {
  heatmap: boolean;
  bubbles: boolean;
  signals: boolean;
}

interface Props extends ChartLayers {
  view: ChartView;
  /** Mas reciente primero */
  trades: AggTrade[];
  /** Antiguo -> reciente */
  columns: DepthColumn[];
  step: number;
  signalList: OrderflowSignal[];
  barMs: number;
}

export const PAD_RIGHT = 72;
export const PAD_BOTTOM = 22;
/** fuente de los ejes; se fija al montar con la de la pagina (chartMono) */
let FONT = "11px ui-monospace, Consolas, monospace";
/** El heatmap se repinta como mucho cada HEAT_REFRESH ms; entre repintados se desplaza la imagen cacheada. */
const HEAT_REFRESH = 100;
/** Tope de burbujas por frame: con ventanas largas solo se dibujan las de mayor volumen. */
const MAX_BUBBLES = 2500;

/** Radio de burbuja segun USD (raiz para que las ballenas no tapen todo). */
const radius = (usd: number) => Math.min(36, 2 + Math.sqrt(usd) / 10);
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

interface HeatCache {
  canvas: HTMLCanvasElement;
  /** borde derecho (ms) con el que se pinto */
  end: number;
  lo: number;
  hi: number;
  w: number;
  h: number;
  win: number;
  ncols: number;
  /** Liquidez de referencia (p97 visible): una celda >= ref esta saturada = zona caliente */
  ref: number;
}

/**
 * Grafica estilo Bookmap: heatmap de liquidez (depth) + burbujas de trades (aggTrades) + senales de orderflow,
 * sobre precio vs tiempo. Zoom/desplazamiento via `view` (compartido con la grafica de CVD).
 */
export function BookmapChart(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // El bucle de dibujo lee siempre las ultimas props sin reiniciarse.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const mono = chartMono();
    FONT = `11px ${mono}`;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const cache: HeatCache = { canvas: document.createElement("canvas"), end: 0, lo: 0, hi: 0, w: 0, h: 0, win: 0, ncols: -1, ref: 0 };
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let bubbleMin = 0;
    let bubbleMinAt = 0;

    const plot = () => ({ pw: w - PAD_RIGHT, ph: h - PAD_BOTTOM });
    const detach = attachViewInteractions(canvas, propsRef.current.view, plot, true);

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cache.canvas.width = canvas.width;
      cache.canvas.height = canvas.height;
      cache.ncols = -1; // invalida
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    /** Pinta el heatmap en la cache (coordenadas CSS, ancla de tiempo = `end`). */
    const paintHeat = (cols: DepthColumn[], step: number, from: number, end: number, win: number, lo: number, hi: number, pw: number, ph: number) => {
      const c = cache.canvas.getContext("2d")!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      cache.ref = 0;
      const x = (t: number) => ((t - from) / win) * pw;
      const y = (p: number) => ph - ((p - lo) / (hi - lo)) * ph;

      // Columnas visibles (una de margen a cada lado)
      let first = 0;
      while (first < cols.length && cols[first]!.time < from) first++;
      let last = first;
      while (last < cols.length && cols[last]!.time <= end) last++;
      const vis = cols.slice(Math.max(0, first - 1), Math.min(cols.length, last + 1));
      if (!vis.length) return;

      // Escala de color: percentil 97 de las celdas visibles (las "paredes" saturan, el resto se ve)
      const sample: number[] = [];
      for (const col of vis) for (let i = 0; i < col.q.length; i += 3) if (col.q[i]! > 0) sample.push(col.q[i]!);
      if (!sample.length) return;
      sample.sort((a, b) => a - b);
      const ref = sample[Math.floor(sample.length * 0.97)] || sample[sample.length - 1]!;

      const cellH = Math.max(1, (step / (hi - lo)) * ph);
      // Con ventanas largas hay mas columnas que pixeles: se salta alguna y se ensancha la siguiente
      const colPx = (1000 / win) * pw;
      const stride = Math.max(1, Math.floor(1 / Math.max(colPx, 1e-6)));
      for (let k = 0; k < vis.length; k += stride) {
        const col = vis[k]!;
        const x0 = Math.floor(x(col.time));
        const nextT = k + stride < vis.length ? vis[k + stride]!.time : Math.min(end, col.time + 2000);
        const cw = Math.max(1, Math.ceil(x(nextT)) - x0);
        if (x0 > pw || x0 + cw < 0) continue;
        for (let i = 0; i < col.q.length; i++) {
          const q = col.q[i]!;
          if (q <= 0) continue;
          const price = col.lo + (i + 1) * step; // borde superior del bucket
          if (price < lo || price - step > hi) continue;
          const t = Math.min(1, Math.sqrt(q / ref));
          // Debajo del precio medio = bids (compra, verde); encima = asks (venta, rojo)
          const isBid = col.lo + (i + 0.5) * step < col.mid;
          c.fillStyle = (isBid ? BUY_LUT : SELL_LUT)[Math.round(t * 255)]!;
          c.fillRect(x0, Math.floor(y(price)), cw, Math.ceil(cellH) + 1);
        }
      }
      cache.ref = ref;
      cache.end = end;
    };

    const tag = (text: string, x: number, y: number, rgb: string) => {
      ctx.font = `bold 10px ${mono}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.strokeText(text, x, y);
      ctx.lineWidth = 1;
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fillText(text, x, y);
      ctx.font = FONT;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { view, heatmap, bubbles, signals: showSignals, trades, columns, step, signalList, barMs } = propsRef.current;
      const win = view.winMs;
      const end = view.end();
      const from = end - win;
      const live = view.endOffset === 0;
      const { pw, ph } = plot();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (pw <= 0 || ph <= 0) return;

      // Trades visibles (lista newest-first: se saltan los posteriores a `end` y se corta al salir de la ventana)
      const vis: AggTrade[] = [];
      for (const t of trades) {
        if (t.time > end) continue;
        if (t.time < from) break;
        vis.push(t);
      }
      vis.reverse();

      // Rango de precio: trades visibles + mids visibles (autoescala) o el manual del usuario
      let min = Infinity;
      let max = -Infinity;
      for (const t of vis) {
        if (t.price < min) min = t.price;
        if (t.price > max) max = t.price;
      }
      for (let i = columns.length - 1; i >= 0; i--) {
        const col = columns[i]!;
        if (col.time > end) continue;
        if (col.time < from) break;
        if (col.mid < min) min = col.mid;
        if (col.mid > max) max = col.mid;
      }
      let lo: number;
      let hi: number;
      if (view.priceCenter !== null && view.priceSpan !== null) {
        lo = view.priceCenter - view.priceSpan / 2;
        hi = view.priceCenter + view.priceSpan / 2;
      } else if (Number.isFinite(min)) {
        // Minimo de ~±0.04% para que el heatmap tenga contexto aunque el precio este quieto
        const mid = (max + min) / 2;
        const span = Math.max((max - min) * 1.3, mid * 0.0008);
        lo = mid - span / 2;
        hi = mid + span / 2;
      } else {
        ctx.fillStyle = "#6b6b6b";
        ctx.font = FONT;
        ctx.fillText("Sin datos en esta vista…", 16, 24);
        return;
      }
      view.lastRange = { lo, hi };
      const x = (t: number) => ((t - from) / win) * pw;
      const y = (p: number) => ph - ((p - lo) / (hi - lo)) * ph;

      // Heatmap (cacheado, ver HEAT_REFRESH): entre repintados se desplaza la imagen
      if (heatmap && columns.length) {
        const stale =
          Math.abs(end - cache.end) > HEAT_REFRESH ||
          cache.lo !== lo ||
          cache.hi !== hi ||
          cache.w !== w ||
          cache.h !== h ||
          cache.win !== win ||
          cache.ncols !== columns.length;
        if (stale) {
          paintHeat(columns, step, from, end, win, lo, hi, pw, ph);
          Object.assign(cache, { lo, hi, w, h, win, ncols: columns.length });
        }
        const dx = -((end - cache.end) / win) * pw;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, pw, ph);
        ctx.clip();
        ctx.drawImage(cache.canvas, dx, 0, w, h);
        ctx.restore();
      }

      ctx.font = FONT;
      ctx.lineWidth = 1;
      const grid = heatmap ? "rgba(255,255,255,0.08)" : "#1f1f1f";

      // Grilla horizontal + etiquetas de precio
      ctx.strokeStyle = grid;
      ctx.fillStyle = "#8f8f8f";
      for (let i = 0; i <= 5; i++) {
        const p = lo + ((hi - lo) * i) / 5;
        const yy = Math.round(y(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(pw, yy);
        ctx.stroke();
        ctx.fillText(p.toFixed(2), pw + 6, yy + 4);
      }
      // Grilla vertical + etiquetas de tiempo
      for (let i = 0; i <= 4; i++) {
        const t = from + (win * i) / 4;
        const xx = Math.round(x(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, ph);
        ctx.stroke();
        ctx.fillText(fmtClockHMS(t), Math.max(2, Math.min(xx - 20, pw - 50)), h - 6);
      }

      // Todo lo siguiente se recorta al area de trazado
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pw, ph);
      ctx.clip();

      // Linea de precio escalonada (con muchos puntos se submuestrea)
      if (vis.length) {
        ctx.strokeStyle = heatmap ? "rgba(255,255,255,0.7)" : "#6b6b6b";
        ctx.beginPath();
        const stride = Math.max(1, Math.floor(vis.length / (pw * 2)));
        let prevY = 0;
        for (let i = 0; i < vis.length; i += stride) {
          const t = vis[i]!;
          const xx = x(t.time);
          const yy = y(t.price);
          if (i === 0) ctx.moveTo(xx, yy);
          else {
            ctx.lineTo(xx, prevY);
            ctx.lineTo(xx, yy);
          }
          prevY = yy;
        }
        if (live) ctx.lineTo(pw, prevY);
        ctx.stroke();
      }

      // Senales de orderflow
      if (showSignals) {
        for (const s of signalList) {
          const x0 = x(s.barStart);
          const x1 = x(s.barStart + barMs);
          const rgb = biasRgb(s.bias);
          const lbl = `${SIGNAL_INFO[s.type].short}${biasArrow(s.bias)}`;
          if (s.type === "cvdDivergence" && s.link) {
            const fx = x(s.link.from.time);
            const tx = x(s.link.to.time);
            if (tx < 0 || fx > pw) continue;
            ctx.setLineDash([5, 4]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = `rgba(${rgb},0.95)`;
            ctx.beginPath();
            ctx.moveTo(fx, y(s.link.from.price));
            ctx.lineTo(tx, y(s.link.to.price));
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
            for (const [px, py] of [[fx, y(s.link.from.price)], [tx, y(s.link.to.price)]] as const) {
              ctx.beginPath();
              ctx.arc(px, py, 3.5, 0, Math.PI * 2);
              ctx.fillStyle = `rgb(${rgb})`;
              ctx.fill();
            }
            tag(lbl, tx - 12, y(s.link.to.price) + (s.bias === "bullish" ? 16 : -8), rgb);
            continue;
          }
          if (x1 < 0 || x0 > pw) continue;
          const top = y(s.priceHi);
          const bottom = y(s.priceLo);
          const rw = Math.max(6, x1 - x0);
          if (s.type === "stackedImbalance") {
            ctx.fillStyle = `rgba(${rgb},0.2)`;
            ctx.fillRect(x0, top, rw, Math.max(2, bottom - top));
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = `rgba(${rgb},0.9)`;
            ctx.strokeRect(x0 + 0.5, top + 0.5, rw, Math.max(2, bottom - top));
            ctx.setLineDash([]);
            tag(`${lbl}×${s.strength}`, x0 + 3, top + 11, rgb);
          } else if (s.type === "absorption") {
            ctx.lineWidth = 2;
            ctx.strokeStyle = `rgba(${rgb},1)`;
            ctx.strokeRect(x0 + 1, top, rw - 2, Math.max(3, bottom - top));
            ctx.lineWidth = 1;
            tag(lbl, x0 + 3, s.bias === "bullish" ? bottom + 12 : top - 5, rgb);
          } else {
            // exhaustion: marca en el extremo
            const cx = (x0 + x1) / 2;
            const cy = s.bias === "bullish" ? bottom : top; // bullish = agotamiento vendedor en el minimo
            ctx.beginPath();
            ctx.arc(cx, cy, 5, 0, Math.PI * 2);
            ctx.lineWidth = 2;
            ctx.strokeStyle = `rgb(${rgb})`;
            ctx.stroke();
            ctx.lineWidth = 1;
            tag(lbl, cx - 14, s.bias === "bullish" ? cy + 18 : cy - 9, rgb);
          }
        }
      }

      // Burbujas (grandes al fondo). Con ventanas largas, solo las de mayor volumen (umbral recalculado 2 veces/s)
      if (bubbles && vis.length) {
        const nowMs = performance.now();
        if (vis.length > MAX_BUBBLES) {
          if (nowMs - bubbleMinAt > 500) {
            bubbleMinAt = nowMs;
            const usds = vis.map((t) => t.price * t.quantity).sort((a, b) => b - a);
            bubbleMin = usds[MAX_BUBBLES - 1] ?? 0;
          }
        } else bubbleMin = 0;
        const shown = vis.filter((t) => t.price * t.quantity >= bubbleMin).sort((a, b) => b.price * b.quantity - a.price * a.quantity);
        for (const t of shown) {
          const c = t.isBuyerMaker ? SELL_RGB : BUY_RGB;
          ctx.beginPath();
          ctx.arc(x(t.time), y(t.price), radius(t.price * t.quantity), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${c},0.4)`;
          ctx.fill();
          ctx.strokeStyle = `rgba(${c},0.95)`;
          ctx.stroke();
        }
      }

      // Zonas calientes del heatmap (solo en vivo): la pared mas grande de cada lado en la ultima columna
      if (live && heatmap && cache.ref > 0 && columns.length) {
        const col = columns[columns.length - 1]!;
        let bi = -1;
        let ai = -1;
        for (let i = 0; i < col.q.length; i++) {
          const q = col.q[i]!;
          if (q <= 0) continue;
          if (col.lo + (i + 0.5) * step < col.mid) {
            if (bi < 0 || q > col.q[bi]!) bi = i;
          } else if (ai < 0 || q > col.q[ai]!) ai = i;
        }
        const hot = (i: number, buy: boolean, nudge: number) => {
          if (i < 0 || col.q[i]! < cache.ref) return;
          const price = col.lo + (i + 0.5) * step;
          if (price < lo || price > hi) return;
          const text = `${buy ? "Zona caliente de compra" : "Zona caliente de venta"} · ≈ $${compact.format(col.q[i]! * price)}`;
          ctx.font = `bold 11px ${mono}`;
          const tw = ctx.measureText(text).width + 14;
          const tx = pw - tw - 8;
          const ty = Math.max(11, Math.min(ph - 11, y(price) + nudge));
          const c = buy ? BUY_RGB : SELL_RGB;
          ctx.fillStyle = "rgba(10,10,10,0.85)";
          ctx.fillRect(tx, ty - 9, tw, 18);
          ctx.strokeStyle = `rgba(${c},1)`;
          ctx.strokeRect(tx + 0.5, ty - 8.5, tw - 1, 17);
          ctx.fillStyle = `rgb(${c})`;
          ctx.fillText(text, tx + 7, ty + 4);
        };
        const close = bi >= 0 && ai >= 0 && Math.abs(y(col.lo + (bi + 0.5) * step) - y(col.lo + (ai + 0.5) * step)) < 20;
        hot(ai, false, close ? -10 : 0);
        hot(bi, true, close ? 10 : 0);
        ctx.font = FONT;
      }
      ctx.restore();

      // Ultimo precio (solo en vivo)
      const last = vis[vis.length - 1];
      if (live && last) {
        const ly = Math.round(y(last.price)) + 0.5;
        if (ly >= 8 && ly <= ph) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = "rgba(245,245,245,0.85)";
          ctx.beginPath();
          ctx.moveTo(0, ly);
          ctx.lineTo(pw, ly);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#f5f5f5";
          ctx.fillRect(pw, ly - 8, PAD_RIGHT, 16);
          ctx.fillStyle = "#0a0a0a";
          ctx.fillText(last.price.toFixed(2), pw + 6, ly + 4);
        }
      }

      if (!live) {
        ctx.fillStyle = "rgba(245,245,245,0.92)";
        ctx.font = `bold 11px ${mono}`;
        ctx.fillText("Vista histórica · doble clic para volver en vivo", 10, 16);
        ctx.font = FONT;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      detach();
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-[320px] w-full select-none bg-screen sm:h-[420px]" />;
}
