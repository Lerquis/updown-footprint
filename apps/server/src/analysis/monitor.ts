import type { MarketSummary, Trend } from "@updown/protocol";
import type { OrderflowEngine } from "./engine.js";
import { evaluateScenarios } from "./scenarios.js";

export interface MonitorConfig {
  lookbackMs: number;
  recentBars: number;
  barMs: number;
  /** Variacion de precio (fraccion) por debajo de la cual se considera plano: 0.0001 = 0.01% */
  priceFlatPct: number;
  /** |variacion CVD| / volumen de la ventana por debajo de la cual el CVD se considera plano */
  cvdFlatShare: number;
  historyMax: number;
}

export const DEFAULT_MONITOR = { priceFlatPct: 0.0001, cvdFlatShare: 0.1, historyMax: 50 };

/** Lee el motor de orderflow y produce un `MarketSummary`: tendencias + senales recientes => escenarios. */
export class AnalysisMonitor {
  /** Cambios de lectura (bias o conjunto de escenarios), el mas reciente al final */
  readonly history: MarketSummary[] = [];
  last: MarketSummary | null = null;
  private lastKey = "";

  constructor(
    private readonly engine: OrderflowEngine,
    private readonly cfg: MonitorConfig,
  ) {}

  /** Recalcula. Devuelve null si aun no hay datos suficientes. `changed` = la lectura cambio de verdad. */
  update(): { summary: MarketSummary; changed: boolean } | null {
    const pts = this.engine.cvdPoints;
    const lastPt = pts[pts.length - 1];
    if (!lastPt || pts.length < 10 || !lastPt.price) return null;

    const from = lastPt.time - this.cfg.lookbackMs;
    let i = pts.length - 1;
    while (i > 0 && pts[i - 1]!.time >= from) i--;
    const first = pts[i]!;
    let vol = 0;
    for (let k = i; k < pts.length; k++) vol += pts[k]!.vol;

    const priceChange = lastPt.price - first.price;
    const cvdChange = lastPt.cvd - first.cvd;
    const priceTrend: Trend =
      Math.abs(priceChange) >= this.cfg.priceFlatPct * lastPt.price ? (priceChange > 0 ? "up" : "down") : "flat";
    const cvdTrend: Trend = vol > 0 && Math.abs(cvdChange) / vol >= this.cfg.cvdFlatShare ? (cvdChange > 0 ? "up" : "down") : "flat";

    const recentFrom = lastPt.time - this.cfg.recentBars * this.cfg.barMs;
    const recent = this.engine.signals.filter((s) => s.time >= recentFrom);
    const has = new Set(recent.map((s) => `${s.type}:${s.bias}`));

    const { scenarios, score, bias } = evaluateScenarios({
      priceTrend,
      cvdTrend,
      has: (type, b) => has.has(`${type}:${b}`),
    });

    const summary: MarketSummary = {
      time: lastPt.time,
      price: lastPt.price,
      lookbackMs: this.cfg.lookbackMs,
      priceTrend,
      cvdTrend,
      priceChange: Math.round(priceChange * 100) / 100,
      cvdChange: Math.round(cvdChange * 1000) / 1000,
      barDelta: this.engine.formingBar?.delta ?? 0,
      signalIds: recent.map((s) => s.id),
      scenarios,
      score,
      bias,
    };

    const key = `${bias}|${scenarios.map((s) => s.id).join(",")}`;
    const changed = key !== this.lastKey;
    this.lastKey = key;
    this.last = summary;
    if (changed) {
      this.history.push(summary);
      if (this.history.length > this.cfg.historyMax) this.history.shift();
    }
    return { summary, changed };
  }
}
