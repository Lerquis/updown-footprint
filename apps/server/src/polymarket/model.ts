import type { CvdPoint, OrderflowSignal, SignalType } from "@updown/protocol";

/**
 * Matematica pura del motor de senales (sin estado, sin I/O). Ver docs/features/signal-engine.md.
 *
 * Idea: Polymarket resuelve Up si el TWAP de 60 s de Chainlink al cierre >= el TWAP al inicio (price to beat).
 * Modelamos el precio como movimiento browniano con volatilidad `sigma` (USD/raiz(s)) y sacamos la
 * probabilidad de que ese TWAP final supere el price to beat. El flujo (footprint/CVD) solo desplaza
 * un poco la media; luego se mezcla con la probabilidad del propio mercado para no fiarse a ciegas.
 */

export interface ModelConfig {
  /** ventana del TWAP con que resuelve el mercado (s); 0 = resuelve con el precio puntual (Predict.fun) */
  twapSeconds: number;
  /** ventana (s) de la media de Binance con que se calcula el basis contra Chainlink; por defecto = twapSeconds */
  basisSeconds?: number;
  /** cuanto desplaza la media el flujo maximo (en sigmas de 1 s por raiz de segundo de horizonte) */
  flowGain: number;
  /** horizonte (s) tras el cual el flujo deja de informar */
  flowHorizonS: number;
  /** peso del modelo al mezclar con el mercado (1 = solo modelo, 0 = solo mercado) */
  modelWeight: number;
  /** vida media (s) de una senal de footprint al puntuar el flujo */
  signalHalfLifeS: number;
  /** ventana (s) del delta de CVD */
  cvdWindowS: number;
  /** peso de cada tipo de senal */
  signalWeights: Record<SignalType, number>;
}

export const DEFAULT_MODEL: ModelConfig = {
  twapSeconds: 60,
  flowGain: 0.3,
  flowHorizonS: 30,
  modelWeight: 0.6,
  signalHalfLifeS: 45,
  cvdWindowS: 20,
  signalWeights: { stackedImbalance: 1, absorption: 0.8, exhaustion: 0.8, cvdDivergence: 0.6 },
};

/** Funcion de distribucion normal estandar (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Formula de la comision taker: `pq` = Polymarket (feeRate · p · (1 - p)) · `min` = Predict.fun (feeRate · min(p, 1 - p)) */
export type FeeKind = "pq" | "min";
/** Comision de taker por token (USDC). Los makers no pagan. */
export const takerFee = (price: number, feeRate: number, kind: FeeKind = "pq") =>
  kind === "min" ? feeRate * Math.min(price, 1 - price) : feeRate * price * (1 - price);
/** Ventana del basis: `basisSeconds` o, si no se da, la del TWAP */
export const basisWindow = (cfg: Pick<ModelConfig, "twapSeconds" | "basisSeconds">) => cfg.basisSeconds ?? cfg.twapSeconds;

export interface ProbInput {
  /** precio actual en unidades Chainlink (Binance + basis) */
  x: number;
  /** price to beat */
  k: number;
  /** segundos hasta el cierre */
  tau: number;
  /** USD por raiz de segundo */
  sigma: number;
  /** media de x desde que empezo la ultima ventana TWAP (`end - twapSeconds`); null si aun no empieza */
  tailAvg: number | null;
  /** puntuacion de flujo -1..1 */
  flow: number;
}

/**
 * P(el TWAP de cierre >= price to beat) segun el modelo de precio + flujo (sin mezclar con el mercado).
 *
 * - Faltan mas de `T` s: cierre = media de un tramo de `T` s que empieza en `tau - T`; varianza sigma²·(tau - T + T/3).
 * - Faltan menos de `T` s: parte del TWAP ya es conocido (`tailAvg`) y solo queda el resto, con varianza (w·sigma)²·tau/3, w = tau/T.
 */
export function modelProbUp(i: ProbInput, cfg: ModelConfig = DEFAULT_MODEL): number {
  const T = cfg.twapSeconds;
  const tau = Math.max(0, i.tau);
  const drift = cfg.flowGain * i.flow * i.sigma * Math.sqrt(Math.min(tau, cfg.flowHorizonS));
  let mean: number;
  let variance: number;
  if (tau > T || T <= 0) {
    // sin TWAP (T = 0) el cierre es el precio puntual: varianza sigma² · tau
    mean = i.x + drift;
    variance = i.sigma ** 2 * (tau - T + T / 3);
  } else {
    const w = tau / T;
    const known = i.tailAvg ?? i.x;
    mean = (1 - w) * known + w * (i.x + drift);
    variance = (w * i.sigma) ** 2 * (tau / 3);
  }
  const sd = Math.max(Math.sqrt(variance), i.sigma, 1e-9); // suelo: un segundo de volatilidad
  return clamp(normCdf((mean - i.k) / sd), 0.001, 0.999);
}

/** Mezcla en logit la probabilidad del modelo con la del mercado (mid de Up). Sin mercado, devuelve el modelo. */
export function blend(pModel: number, pMarket: number | null, modelWeight: number): number {
  if (pMarket === null) return pModel;
  const m = clamp(pMarket, 0.01, 0.99);
  return clamp(sigmoid(modelWeight * logit(pModel) + (1 - modelWeight) * logit(m)), 0.001, 0.999);
}

/**
 * Volatilidad realizada en USD por raiz de segundo. Usa retornos de 5 s (el precio del ultimo trade a 1 s tiene
 * ruido de rebote bid/ask que inflaria la volatilidad) ponderados con EWMA (vida media `halfLifeS`).
 * null si hay menos de 30 puntos.
 */
export function estimateSigma(cvd: CvdPoint[], halfLifeS = 150, maxPoints = 900): number | null {
  const n = cvd.length;
  const from = Math.max(5, n - maxPoints);
  if (n - from < 30) return null;
  const lambda = Math.pow(0.5, 1 / halfLifeS);
  let num = 0;
  let den = 0;
  let w = 1;
  for (let i = n - 1; i >= from; i--) {
    const a = cvd[i]!.price;
    const b = cvd[i - 5]!.price;
    if (a > 0 && b > 0) {
      const r = Math.log(a / b);
      num += w * r * r;
      den += w;
    }
    w *= lambda;
  }
  if (den === 0) return null;
  const last = cvd[n - 1]!.price;
  return Math.max(last * 1e-5, last * Math.sqrt(num / den / 5)); // suelo ~ $0.6 por raiz(s) en BTC
}

/** Media del precio de Binance de los ultimos `seconds` s. null si no hay datos recientes. */
export function recentAvg(cvd: CvdPoint[], now: number, seconds: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = cvd.length - 1; i >= 0 && cvd[i]!.time > now - seconds * 1000; i--) {
    if (cvd[i]!.time > now) continue;
    sum += cvd[i]!.price;
    n++;
  }
  return n >= Math.min(10, seconds / 2) ? sum / n : null;
}

/**
 * Puntuacion de flujo -1..1 en el instante `now`: mezcla 50/50 de
 * (a) senales de footprint recientes (signo = sesgo, peso por tipo, decaen exponencialmente) y
 * (b) el delta de CVD de los ultimos `cvdWindowS` s relativo al volumen operado.
 */
export function flowScore(now: number, signals: OrderflowSignal[], cvd: CvdPoint[], cfg: ModelConfig = DEFAULT_MODEL): number {
  let sig = 0;
  for (const s of signals) {
    const age = (now - s.time) / 1000;
    if (age < 0 || age > cfg.signalHalfLifeS * 6) continue;
    sig += (s.bias === "bullish" ? 1 : -1) * cfg.signalWeights[s.type] * Math.pow(0.5, age / cfg.signalHalfLifeS);
  }
  let cvdPart = 0;
  const last = cvd[cvd.length - 1];
  if (last) {
    let i = cvd.length - 1;
    let vol = 0;
    while (i > 0 && cvd[i - 1]!.time >= last.time - cfg.cvdWindowS * 1000) {
      vol += cvd[i]!.vol;
      i--;
    }
    vol += cvd[i]!.vol;
    if (vol > 0) cvdPart = clamp((last.cvd - cvd[i]!.cvd) / vol, -1, 1);
  }
  return clamp(0.5 * Math.tanh(sig) + 0.5 * cvdPart, -1, 1);
}

export interface FlowContext {
  binance: number | null;
  basis: number | null;
  sigma: number | null;
  flow: number;
}

/** Contexto de Binance del segundo `now`: precio, basis contra Chainlink (TWAP), volatilidad y flujo. */
export function flowContext(
  now: number,
  chainlink: number | null,
  cvd: CvdPoint[],
  signals: OrderflowSignal[],
  cfg: ModelConfig = DEFAULT_MODEL,
): FlowContext {
  const last = cvd[cvd.length - 1];
  const fresh = last && now - last.time <= 3000 ? last : undefined;
  const avg = recentAvg(cvd, now, basisWindow(cfg));
  return {
    binance: fresh?.price ?? null,
    basis: chainlink !== null && avg !== null ? chainlink - avg : null,
    sigma: estimateSigma(cvd),
    flow: flowScore(now, signals, cvd, cfg),
  };
}
