import type { Bias, FootprintBar, FootprintLevel, ImbalanceMark, OrderflowSignal } from "@updown/protocol";

/** Parametros de los detectores. Ver docs/features/orderflow-signals.md para la definicion de cada uno. */
export interface DetectorConfig {
  tick: number;
  barMs: number;
  imbalanceRatio: number;
  imbalanceMinVol: number;
  imbalanceMinStack: number;
  /** Absorcion: fraccion de niveles que forman cada extremo de la barra */
  edgeZone: number;
  /** Absorcion: cuota minima del volumen de la barra concentrada en el extremo */
  absorptionShare: number;
  /** Absorcion: |delta| / volumen minimo dentro del extremo */
  absorptionDeltaRatio: number;
  /** Agotamiento: cuota maxima del volumen de la barra en los 2 niveles del extremo */
  exhaustionThinShare: number;
  /** Divergencia CVD: barras previas consideradas */
  divergenceLookback: number;
}

export const DEFAULT_DETECTOR: Omit<DetectorConfig, "tick" | "barMs"> = {
  imbalanceRatio: 3,
  imbalanceMinVol: 0.05,
  imbalanceMinStack: 3,
  edgeZone: 0.25,
  absorptionShare: 0.3,
  absorptionDeltaRatio: 0.2,
  exhaustionThinShare: 0.05,
  divergenceLookback: 8,
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const lvlVol = (l: FootprintLevel) => l[1] + l[2];
const key = (p: number, tick: number) => Math.round(p / tick);

/**
 * Desequilibrios diagonales: compra en P si ask(P) >= ratio × bid(P - tick);
 * venta en P si bid(P) >= ratio × ask(P + tick). Un nivel vecino vacio cuenta como 0 (ratio infinito),
 * pero el volumen del nivel debe superar `imbalanceMinVol`.
 */
export function computeImbalances(levels: FootprintLevel[], cfg: DetectorConfig): ImbalanceMark[] {
  const byKey = new Map<number, FootprintLevel>();
  for (const l of levels) byKey.set(key(l[0], cfg.tick), l);
  const out: ImbalanceMark[] = [];
  for (const l of levels) {
    const k = key(l[0], cfg.tick);
    const below = byKey.get(k - 1);
    const above = byKey.get(k + 1);
    if (l[2] >= cfg.imbalanceMinVol && l[2] >= cfg.imbalanceRatio * (below?.[1] ?? 0)) out.push({ price: l[0], side: "buy" });
    if (l[1] >= cfg.imbalanceMinVol && l[1] >= cfg.imbalanceRatio * (above?.[2] ?? 0)) out.push({ price: l[0], side: "sell" });
  }
  return out;
}

const signal = (
  bar: FootprintBar,
  cfg: DetectorConfig,
  s: Pick<OrderflowSignal, "type" | "bias" | "priceLo" | "priceHi" | "strength" | "link"> & { suffix?: string },
): OrderflowSignal => ({
  id: `${s.type}:${s.bias}:${bar.start}${s.suffix ? ":" + s.suffix : ""}`,
  type: s.type,
  bias: s.bias,
  barStart: bar.start,
  time: bar.start + cfg.barMs,
  priceLo: s.priceLo,
  priceHi: s.priceHi,
  strength: s.strength,
  link: s.link,
});

/** Apilados: >= minStack niveles CONSECUTIVOS con desequilibrio del mismo lado. Una senal por tramo. */
export function detectStackedImbalances(bar: FootprintBar, cfg: DetectorConfig): OrderflowSignal[] {
  const out: OrderflowSignal[] = [];
  for (const side of ["buy", "sell"] as const) {
    const ks = bar.imbalances
      .filter((m) => m.side === side)
      .map((m) => key(m.price, cfg.tick))
      .sort((a, b) => a - b);
    let run: number[] = [];
    const flush = () => {
      if (run.length >= cfg.imbalanceMinStack) {
        const bias: Bias = side === "buy" ? "bullish" : "bearish";
        out.push(
          signal(bar, cfg, {
            type: "stackedImbalance",
            bias,
            priceLo: run[0]! * cfg.tick,
            priceHi: (run[run.length - 1]! + 1) * cfg.tick,
            strength: run.length,
            suffix: String(run[0]),
          }),
        );
      }
      run = [];
    };
    for (const k of ks) {
      if (run.length && k !== run[run.length - 1]! + 1) flush();
      run.push(k);
    }
    flush();
  }
  return out;
}

/**
 * Absorcion: el extremo de la barra concentra mucho volumen AGRESIVO en una direccion y aun asi el precio
 * no avanza (cierra lejos de ese extremo). Compradora = ventas agresivas absorbidas en el minimo.
 */
export function detectAbsorption(bar: FootprintBar, prev: FootprintBar[], cfg: DetectorConfig): OrderflowSignal[] {
  const n = bar.levels.length;
  const range = bar.high - bar.low;
  if (n < 4 || range <= 0 || bar.volume <= 0) return [];
  if (prev.length) {
    const avg = sum(prev.map((b) => b.volume)) / prev.length;
    if (bar.volume < avg * 0.7) return []; // barra irrelevante frente a las anteriores
  }
  const zn = Math.max(2, Math.ceil(n * cfg.edgeZone));
  const low = bar.levels.slice(0, zn);
  const high = bar.levels.slice(n - zn);
  const out: OrderflowSignal[] = [];

  const lowVol = sum(low.map(lvlVol));
  const lowDelta = sum(low.map((l) => l[2] - l[1]));
  if (lowVol / bar.volume >= cfg.absorptionShare && lowDelta <= -cfg.absorptionDeltaRatio * lowVol && bar.close >= bar.low + 0.5 * range) {
    out.push(
      signal(bar, cfg, {
        type: "absorption",
        bias: "bullish",
        priceLo: low[0]![0],
        priceHi: low[low.length - 1]![0] + cfg.tick,
        strength: lowVol / bar.volume,
      }),
    );
  }
  const highVol = sum(high.map(lvlVol));
  const highDelta = sum(high.map((l) => l[2] - l[1]));
  if (highVol / bar.volume >= cfg.absorptionShare && highDelta >= cfg.absorptionDeltaRatio * highVol && bar.close <= bar.high - 0.5 * range) {
    out.push(
      signal(bar, cfg, {
        type: "absorption",
        bias: "bearish",
        priceLo: high[0]![0],
        priceHi: high[high.length - 1]![0] + cfg.tick,
        strength: highVol / bar.volume,
      }),
    );
  }
  return out;
}

/**
 * Agotamiento: la barra extiende el extremo de la anterior (>= 2 ticks) pero con muy poco volumen en los
 * 2 niveles extremos, y con fuerza decreciente (menos volumen o menos delta a favor que la barra previa).
 * Alcista (agotamiento de compradores => sesgo bajista) en maximos; vendedor en minimos.
 */
export function detectExhaustion(bar: FootprintBar, prev: FootprintBar[], cfg: DetectorConfig): OrderflowSignal[] {
  const last = prev[prev.length - 1];
  const n = bar.levels.length;
  if (!last || n < 4 || bar.volume <= 0) return [];
  const out: OrderflowSignal[] = [];

  if (bar.high - last.high >= 2 * cfg.tick) {
    const top = bar.levels.slice(n - 2);
    const share = sum(top.map(lvlVol)) / bar.volume;
    if (share <= cfg.exhaustionThinShare && (bar.volume <= last.volume || bar.delta <= last.delta)) {
      out.push(signal(bar, cfg, { type: "exhaustion", bias: "bearish", priceLo: top[0]![0], priceHi: top[1]![0] + cfg.tick, strength: share }));
    }
  }
  if (last.low - bar.low >= 2 * cfg.tick) {
    const bottom = bar.levels.slice(0, 2);
    const share = sum(bottom.map(lvlVol)) / bar.volume;
    if (share <= cfg.exhaustionThinShare && (bar.volume <= last.volume || bar.delta >= last.delta)) {
      out.push(signal(bar, cfg, { type: "exhaustion", bias: "bullish", priceLo: bottom[0]![0], priceHi: bottom[1]![0] + cfg.tick, strength: share }));
    }
  }
  return out;
}

/**
 * Divergencia de CVD al cierre de `bar`: nuevo maximo de precio (vs las barras previas) con CVD de cierre MENOR
 * que el de la barra del maximo previo => bajista; nuevo minimo con CVD MAYOR => alcista.
 * `prev` = barras cerradas anteriores (antigua -> reciente).
 */
export function detectCvdDivergence(bar: FootprintBar, prev: FootprintBar[], cfg: DetectorConfig): OrderflowSignal[] {
  const look = prev.slice(-cfg.divergenceLookback);
  if (look.length < 2) return [];
  const gap = 0.15 * (sum(look.map((b) => b.volume)) / look.length); // diferencia minima de CVD
  const out: OrderflowSignal[] = [];
  const pt = (b: FootprintBar, price: number) => ({ time: b.start + cfg.barMs, price, cvd: b.cvdClose });

  const hi = look.reduce((a, b) => (b.high > a.high ? b : a));
  if (bar.high - hi.high >= 2 * cfg.tick && bar.cvdClose < hi.cvdClose - gap) {
    out.push(
      signal(bar, cfg, {
        type: "cvdDivergence",
        bias: "bearish",
        priceLo: hi.high,
        priceHi: bar.high,
        strength: hi.cvdClose - bar.cvdClose,
        link: { from: pt(hi, hi.high), to: pt(bar, bar.high) },
      }),
    );
  }
  const lo = look.reduce((a, b) => (b.low < a.low ? b : a));
  if (lo.low - bar.low >= 2 * cfg.tick && bar.cvdClose > lo.cvdClose + gap) {
    out.push(
      signal(bar, cfg, {
        type: "cvdDivergence",
        bias: "bullish",
        priceLo: bar.low,
        priceHi: lo.low,
        strength: bar.cvdClose - lo.cvdClose,
        link: { from: pt(lo, lo.low), to: pt(bar, bar.low) },
      }),
    );
  }
  return out;
}

/** Todos los detectores sobre una barra recien cerrada. `prev` = barras cerradas anteriores. */
export function detectAll(bar: FootprintBar, prev: FootprintBar[], cfg: DetectorConfig): OrderflowSignal[] {
  return [
    ...detectStackedImbalances(bar, cfg),
    ...detectAbsorption(bar, prev.slice(-5), cfg),
    ...detectExhaustion(bar, prev, cfg),
    ...detectCvdDivergence(bar, prev, cfg),
  ];
}
