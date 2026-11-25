"use client";

import { useEffect, useRef } from "react";
import type { CvdPoint, OrderflowSignal } from "@updown/protocol";
import { attachViewInteractions } from "@/lib/chartInteractions";
import type { ChartView } from "@/lib/chartView";
import { BUY_RGB, SELL_RGB, biasArrow, biasRgb, fmtClockHMS } from "@/lib/flow";
import { PAD_RIGHT } from "./BookmapChart";

interface Props {
  view: ChartView;
  /** Antiguo -> reciente */
  points: CvdPoint[];
  signalList: OrderflowSignal[];
  barMs: number;
  showSignals: boolean;
}

const PAD_BOTTOM = 18;
const FONT = "11px ui-monospace, Consolas, monospace";

/** CVD (delta acumulado) con el MISMO eje de tiempo y zoom que la grafica de precio. Marca las divergencias. */
export function CvdChart(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const plot = () => ({ pw: w - PAD_RIGHT, ph: h - PAD_BOTTOM });
    const detach = attachViewInteractions(canvas, propsRef.current.view, plot, false);
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { view, points, signalList, barMs, showSignals } = propsRef.current;
      const win = view.winMs;
      const end = view.end();
      const from = end - win;
      const { pw, ph } = plot();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (pw <= 0 || ph <= 0) return;
      ctx.font = FONT;

      // Puntos visibles (+1 de margen a cada lado para que la linea llegue al borde)
      let a = 0;
      while (a < points.length && points[a]!.time < from) a++;
      let b = a;
      while (b < points.length && points[b]!.time <= end) b++;
      const vis = points.slice(Math.max(0, a - 1), Math.min(points.length, b + 1));
      if (vis.length < 2) {
        ctx.fillStyle = "#5e6673";
        ctx.fillText("CVD: esperando datos…", 12, 18);
        return;
      }

      let min = Infinity;
      let max = -Infinity;
      for (const p of vis) {
        if (p.cvd < min) min = p.cvd;
        if (p.cvd > max) max = p.cvd;
      }
      const pad = Math.max((max - min) * 0.12, 1e-6);
      const lo = min - pad;
      const hi = max + pad;
      const x = (t: number) => ((t - from) / win) * pw;
      const y = (v: number) => ph - ((v - lo) / (hi - lo)) * ph;

      // Grilla: limites de barra (vertical) y 3 niveles de CVD (horizontal)
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.fillStyle = "#848e9c";
      for (let t = Math.ceil(from / barMs) * barMs; t <= end; t += barMs) {
        const xx = Math.round(x(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, ph);
        ctx.stroke();
      }
      for (let i = 0; i <= 3; i++) {
        const v = lo + ((hi - lo) * i) / 3;
        const yy = Math.round(y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(pw, yy);
        ctx.stroke();
        ctx.fillText(v.toFixed(2), pw + 6, yy + 4);
      }
      for (let i = 0; i <= 4; i++) {
        const t = from + (win * i) / 4;
        const xx = Math.round(x(t));
        ctx.fillText(fmtClockHMS(t), Math.max(2, Math.min(xx - 20, pw - 50)), h - 4);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pw, ph);
      ctx.clip();

      // Linea cero
      if (lo < 0 && hi > 0) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y(0)) + 0.5);
        ctx.lineTo(pw, Math.round(y(0)) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Area + linea (submuestreada si hay mas puntos que pixeles)
      const stride = Math.max(1, Math.floor(vis.length / (pw * 1.5)));
      const grad = ctx.createLinearGradient(0, 0, 0, ph);
      grad.addColorStop(0, "rgba(240,185,11,0.25)");
      grad.addColorStop(1, "rgba(240,185,11,0)");
      ctx.beginPath();
      let lastX = 0;
      for (let i = 0; i < vis.length; i += stride) {
        const p = vis[i]!;
        lastX = x(p.time);
        if (i === 0) ctx.moveTo(lastX, y(p.cvd));
        else ctx.lineTo(lastX, y(p.cvd));
      }
      ctx.strokeStyle = "#f0b90b";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineTo(lastX, ph);
      ctx.lineTo(x(vis[0]!.time), ph);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1;

      // Divergencias: segmento CVD entre los dos extremos que divergen
      if (showSignals) {
        for (const s of signalList) {
          if (s.type !== "cvdDivergence" || !s.link) continue;
          const fx = x(s.link.from.time);
          const tx = x(s.link.to.time);
          if (tx < 0 || fx > pw) continue;
          const rgb = biasRgb(s.bias);
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = `rgba(${rgb},0.95)`;
          ctx.beginPath();
          ctx.moveTo(fx, y(s.link.from.cvd));
          ctx.lineTo(tx, y(s.link.to.cvd));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          for (const [px, py] of [[fx, y(s.link.from.cvd)], [tx, y(s.link.to.cvd)]] as const) {
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = `rgb(${rgb})`;
            ctx.fill();
          }
          ctx.font = "bold 10px ui-monospace, Consolas, monospace";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(0,0,0,0.75)";
          ctx.strokeText(`DIV${biasArrow(s.bias)}`, tx - 12, y(s.link.to.cvd) + (s.bias === "bullish" ? -8 : 15));
          ctx.lineWidth = 1;
          ctx.fillStyle = `rgb(${rgb})`;
          ctx.fillText(`DIV${biasArrow(s.bias)}`, tx - 12, y(s.link.to.cvd) + (s.bias === "bullish" ? -8 : 15));
          ctx.font = FONT;
        }
      }
      ctx.restore();

      // Valor actual
      const last = points[points.length - 1]!;
      const ly = Math.round(y(last.cvd)) + 0.5;
      if (view.endOffset === 0 && ly >= 8 && ly <= ph) {
        const up = last.cvd >= 0;
        ctx.fillStyle = `rgb(${up ? BUY_RGB : SELL_RGB})`;
        ctx.fillRect(pw, ly - 8, PAD_RIGHT, 16);
        ctx.fillStyle = "#0b0e11";
        ctx.fillText(last.cvd.toFixed(2), pw + 6, ly + 4);
      }
      ctx.fillStyle = "#848e9c";
      ctx.fillText("CVD", 8, 14);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      detach();
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-[150px] w-full select-none border-t bg-[#0b0e11]" />;
}
