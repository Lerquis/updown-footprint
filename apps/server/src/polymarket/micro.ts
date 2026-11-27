import type { AggTrade } from "@updown/protocol";

/**
 * Microestructura de Binance para los motores D y E (docs/features/predictive-engines.md): cinco variables que, segun los
 * datos guardados (1,9 M aggTrades, 26 nov), predicen el retorno de los proximos segundos fuera de muestra
 * (correlacion 0,18 a 1-2 s, 0,15 a 5 s, 0,12 a 10 s, 0,08 a 30 s):
 *  - ofi1 / ofi3: desequilibrio de volumen agresor (compra - venta) / total del ultimo 1 s / 3 s (-1..1)
 *  - ret1 / ret3: retorno del ultimo 1 s / 3 s en sigmas (momentum de muy corto plazo)
 *  - imb5: desequilibrio del libro de Binance a +-5 USD del mid (bids - asks) / total (-1..1)
 * Los trades grandes, el CVD de 30 s y la intensidad no aportaron. `npm run calibrate` recalcula los coeficientes.
 */

/** Orden fijo de las variables (los coeficientes van en el mismo orden) */
export const MICRO_FEATURES = ["ofi1", "ofi3", "ret1", "ret3", "imb5"] as const;
export type MicroVector = [number, number, number, number, number];

export interface DriftConfig {
  /** coeficientes de regresion (en sigmas por raiz del horizonte) de cada variable de `MICRO_FEATURES` */
  betas: MicroVector;
  /** horizonte (s) de la prediccion: la deriva no se extiende mas alla */
  horizonS: number;
  /** multiplicador sobre la prediccion lineal (los backtests dieron el mejor resultado fuera de muestra con 3) */
  gain: number;
  /** tope de |gain * z| (en sigmas por raiz del horizonte), contra valores extremos */
  maxZ: number;
  /** rango (USD) alrededor del mid de Binance para el desequilibrio del libro */
  bookRangeUsd: number;
}

/** Coeficientes de la regresion a 30 s (OLS con 12 variables, 70 % entrenamiento / 30 % prueba, 26 nov) */
export const DEFAULT_DRIFT: DriftConfig = {
  betas: [0.024, 0.005, 0.02, 0.01, 0.074],
  horizonS: 30,
  gain: 3,
  maxZ: 1,
  bookRangeUsd: 5,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Prediccion lineal (sigmas por raiz del horizonte): suma de coeficiente x variable. */
export const driftScore = (f: MicroVector, cfg: DriftConfig = DEFAULT_DRIFT): number => f.reduce((s, v, i) => s + v * cfg.betas[i]!, 0);

/**
 * Deriva esperada en USD hasta min(horizonte, tau): `clamp(gain · z) · sigma · raiz(min(H, tau))`.
 * Es lo que se suma al precio actual al calcular la probabilidad (desplaza la media). Funcion pura.
 */
export function predictDrift(f: MicroVector, sigma: number, tau: number, cfg: DriftConfig = DEFAULT_DRIFT): number {
  const z = clamp(cfg.gain * driftScore(f, cfg), -cfg.maxZ, cfg.maxZ);
  return z * sigma * Math.sqrt(Math.max(0, Math.min(cfg.horizonS, tau)));
}

/** Desequilibrio de un libro a +-range del mid: (bids - asks) / (bids + asks), 0 si vacio. Funcion pura. */
export function bookImbalance(bids: Iterable<[number, number]>, asks: Iterable<[number, number]>, mid: number, range: number): number {
  let b = 0;
  let a = 0;
  for (const [p, q] of bids) if (p < mid && p >= mid - range) b += q;
  for (const [p, q] of asks) if (p >= mid && p <= mid + range) a += q;
  return b + a > 0 ? (b - a) / (b + a) : 0;
}

interface T {
  time: number;
  price: number;
  qty: number;
  sell: boolean;
}

/**
 * Ventana deslizante de aggTrades (ultimos segundos) para calcular las variables en cualquier instante, no solo al cerrar
 * cada segundo: el motor decide cada 100 ms.
 */
export class MicroFlow {
  private trades: T[] = [];
  /** ultimo precio anterior a la ventana (referencia para los retornos) */
  private before: number | null = null;

  constructor(private readonly windowMs = 4000) {}

  add(t: AggTrade): void {
    const a = this.trades;
    const x = { time: t.time, price: t.price, qty: t.quantity, sell: t.isBuyerMaker };
    if (!a.length || a[a.length - 1]!.time <= x.time) a.push(x);
    else {
      let i = a.length - 1;
      while (i > 0 && a[i - 1]!.time > x.time) i--;
      a.splice(i, 0, x);
    }
  }

  get lastPrice(): number | null {
    return this.trades.at(-1)?.price ?? this.before;
  }

  get lastTime(): number | null {
    return this.trades.at(-1)?.time ?? null;
  }

  /** Descarta los trades mas viejos que la ventana (conservando el ultimo precio como referencia). */
  private prune(now: number): void {
    let n = 0;
    while (n < this.trades.length && this.trades[n]!.time <= now - this.windowMs) n++;
    if (n) {
      this.before = this.trades[n - 1]!.price;
      this.trades.splice(0, n);
    }
  }

  /** Precio del ultimo trade con time <= t */
  private priceAt(t: number): number | null {
    for (let i = this.trades.length - 1; i >= 0; i--) if (this.trades[i]!.time <= t) return this.trades[i]!.price;
    return this.before;
  }

  /** Variables en el instante `now` (solo trades con time <= now). `imb` = desequilibrio del libro de Binance. null sin sigma o sin precio. */
  features(now: number, sigma: number | null, imb: number): MicroVector | null {
    this.prune(now);
    const last = this.priceAt(now);
    if (sigma === null || !(sigma > 0) || last === null) return null;
    const ofi = (w: number) => {
      let b = 0;
      let s = 0;
      for (let i = this.trades.length - 1; i >= 0; i--) {
        const t = this.trades[i]!;
        if (t.time > now) continue;
        if (t.time <= now - w) break;
        if (t.sell) s += t.qty;
        else b += t.qty;
      }
      return b + s > 0 ? (b - s) / (b + s) : 0;
    };
    const ret = (w: number) => {
      const p = this.priceAt(now - w);
      return p === null ? 0 : (last - p) / (sigma * Math.sqrt(w / 1000));
    };
    return [ofi(1000), ofi(3000), ret(1000), ret(3000), imb];
  }
}
