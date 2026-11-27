import { EventEmitter } from "node:events";
import type { AggTrade, CvdPoint, OrderflowSignal, PmDecision, PmEngineId, PmMarket, PmPoint, PmSignal } from "@updown/protocol";
import { estimateSigma, flowScore, recentAvg } from "./model.js";
import { DEFAULT_STRATEGY, SignalEngine, type StrategyConfig } from "./strategy.js";

/**
 * Motores de senales cronometrados con el reloj de Binance (A y C). Ambos aplican las mismas reglas
 * (`SignalEngine`) una vez por segundo `T` de Binance, en `T + delayMs`, y se diferencian en que datos usan:
 * - `live` (A): lo ultimo recibido del libro y de Chainlink en ese instante (lo mas rapido; depende de la latencia).
 * - `asOf` (C): solo datos con marca de tiempo <= T (Polymarket y Chainlink marcan cada mensaje), para que
 *   servidores en lugares distintos vean la misma foto si los datos llegan antes de `delayMs`.
 * Binance: cada motor arma su propio CVD de 1 s con los aggTrades de tiempo < T (`SecondCvd`).
 * Ver docs/features/engines.md.
 */

interface Stamped<T> {
  time: number;
  v: T;
}

/** Historial corto ordenado por tiempo de un valor; permite pedir "el ultimo con time <= T". */
export class AsOf<T> {
  private items: Stamped<T>[] = [];

  push(time: number, v: T): void {
    const a = this.items;
    if (!a.length || a[a.length - 1]!.time <= time) a.push({ time, v });
    else {
      let i = a.length - 1;
      while (i > 0 && a[i - 1]!.time > time) i--;
      a.splice(i, 0, { time, v }); // llego desordenado (raro)
    }
  }

  /** Ultimo valor con time <= t (o undefined). Con t = Infinity, el mas reciente recibido. */
  at(t: number): T | undefined {
    const a = this.items;
    for (let i = a.length - 1; i >= 0; i--) if (a[i]!.time <= t) return a[i]!.v;
    return undefined;
  }

  /** Descarta lo anterior a `cutoff`, conservando el ultimo valor vigente en `cutoff`. */
  prune(cutoff: number): void {
    let n = 0;
    while (n + 1 < this.items.length && this.items[n + 1]!.time <= cutoff) n++;
    if (n) this.items.splice(0, n);
  }
}

/** Datos de Polymarket compartidos por los motores: cotizaciones por token y precio de Chainlink, con su marca de tiempo. */
export class PmFeed {
  readonly quotes = new Map<string, AsOf<{ bid: number | null; ask: number | null }>>();
  readonly chainlink = new AsOf<number>();

  onChainlink(time: number, value: number): void {
    this.chainlink.push(time < 1e12 ? time * 1000 : time, value);
  }

  onQuote(token: string, bid: number | null, ask: number | null, time: number): void {
    let q = this.quotes.get(token);
    if (!q) this.quotes.set(token, (q = new AsOf()));
    q.push(time, { bid, ask });
  }

  quote(token: string, t: number) {
    return this.quotes.get(token)?.at(t);
  }

  /** Olvida historia vieja (conserva el valor vigente) y los tokens que ya no se usan. */
  prune(cutoff: number, keepTokens: Set<string>): void {
    this.chainlink.prune(cutoff);
    for (const [token, q] of this.quotes) {
      if (!keepTokens.has(token)) this.quotes.delete(token);
      else q.prune(cutoff);
    }
  }
}

/**
 * CVD de 1 s construido solo con trades de tiempo < T, igual que el del motor de orderflow
 * (punto `time` = fin del segundo), pero cerrado por el reloj de Binance y no por la llegada de trades.
 */
export class SecondCvd {
  readonly points: CvdPoint[] = [];
  private pending: AggTrade[] = [];
  private cvd = 0;
  private secVol = 0;
  private lastPrice = 0;
  private curSec = 0;

  constructor(private readonly retentionMs: number) {}

  add(t: AggTrade): void {
    this.pending.push(t);
  }

  private push(): void {
    this.points.push({ time: (this.curSec + 1) * 1000, cvd: Math.round(this.cvd * 1e5) / 1e5, price: this.lastPrice, vol: Math.round(this.secVol * 1e5) / 1e5 });
    this.secVol = 0;
    this.curSec++;
  }

  private advance(time: number): void {
    const sec = Math.floor(time / 1000);
    if (!this.curSec) this.curSec = sec;
    if (sec - this.curSec > 3600) this.curSec = sec;
    while (this.curSec < sec) this.push();
  }

  /** Incorpora los trades con time < T y cierra todos los segundos anteriores a T. */
  closeTo(T: number): void {
    if (!this.curSec && !this.pending.length) return;
    let keep = 0;
    this.pending.sort((a, b) => a.time - b.time || a.id - b.id);
    for (const t of this.pending) {
      if (t.time >= T) {
        this.pending[keep++] = t;
        continue;
      }
      this.advance(t.time);
      this.cvd += t.isBuyerMaker ? -t.quantity : t.quantity;
      this.secVol += t.quantity;
      this.lastPrice = t.price;
    }
    this.pending.length = keep;
    if (this.curSec) this.advance(T);
    const cutoff = T - this.retentionMs;
    let drop = 0;
    while (drop < this.points.length && this.points[drop]!.time < cutoff) drop++;
    if (drop) this.points.splice(0, drop);
  }
}

/** Lo que produce un motor en un segundo: la muestra ("foto"), las senales y el porque */
export interface EngineStep {
  slug: string;
  point: PmPoint;
  signals: PmSignal[];
  decision: PmDecision;
}

export interface TimedEngineEvents {
  step: [EngineStep];
}

export interface TimedEngineOptions {
  id: PmEngineId;
  mode: "live" | "asOf";
  /** ms tras el inicio del segundo de Binance en que decide */
  delayMs: number;
  strategy?: StrategyConfig;
  /** memoria de CVD (debe cubrir la volatilidad y la ventana TWAP; igual que RETENTION_MS) */
  retentionMs: number;
  /** decisiones del market en curso que se conservan (para el canal engines) */
  decisionsMax: number;
}

export class TimedEngine extends EventEmitter<TimedEngineEvents> {
  private readonly cvd: SecondCvd;
  private market: PmMarket | null = null;
  private engine?: SignalEngine;
  private basisEma: number | null = null;
  private lastT = 0;
  /** decisiones del market en curso (para el canal engines) */
  decisions: PmDecision[] = [];

  constructor(
    readonly opts: TimedEngineOptions,
    private readonly feed: PmFeed,
  ) {
    super();
    this.cvd = new SecondCvd(opts.retentionMs);
  }

  get slug(): string | null {
    return this.market?.slug ?? null;
  }

  addTrade(t: AggTrade): void {
    this.cvd.add(t);
  }

  /**
   * Decide el segundo `T` (multiplo de 1000, reloj de Binance) del market que contenga `T`.
   * `signals`: senales de footprint (las de tiempo > T se ignoran). Devuelve el paso o null si no hay market.
   */
  step(T: number, market: PmMarket | null, signals: OrderflowSignal[]): EngineStep | null {
    if (T <= this.lastT) return null;
    this.lastT = T;
    this.cvd.closeTo(T);
    if (!market || T < market.start || T >= market.end) return null;
    if (this.market?.slug !== market.slug) {
      this.market = market;
      this.engine = new SignalEngine(market, this.opts.strategy ?? DEFAULT_STRATEGY);
      this.decisions = [];
    }

    const cfg = this.opts.strategy ?? DEFAULT_STRATEGY;
    const at = this.opts.mode === "live" ? Infinity : T;
    const cvd = this.cvd.points;
    const last = cvd[cvd.length - 1];
    const chain = this.feed.chainlink.at(at) ?? null;
    const avg = recentAvg(cvd, T, cfg.model.twapSeconds);
    const basis = chain !== null && avg !== null ? chain - avg : null;
    if (basis !== null) this.basisEma = this.basisEma === null ? basis : this.basisEma + (1 - Math.pow(0.5, 1 / 60)) * (basis - this.basisEma);
    const up = this.feed.quote(market.upToken, at);
    const down = this.feed.quote(market.downToken, at);
    const point: PmPoint = {
      time: T,
      chainlink: chain,
      upBid: up?.bid ?? null,
      upAsk: up?.ask ?? null,
      downBid: down?.bid ?? null,
      downAsk: down?.ask ?? null,
      binance: last && T - last.time <= 3000 ? last.price : null,
      basis: basis === null ? null : this.basisEma,
      sigma: estimateSigma(cvd),
      flow: flowScore(T, signals, cvd, cfg.model),
      pModel: null,
    };
    const r = this.engine!.step(point);
    point.pModel = r.pUp;
    this.decisions.push(r.decision);
    if (this.decisions.length > this.opts.decisionsMax) this.decisions.shift();
    const out: EngineStep = { slug: market.slug, point, signals: r.signals, decision: r.decision };
    this.emit("step", out);
    return out;
  }
}

/**
 * Programa un motor: un paso por segundo de Binance, `delayMs` despues de que empiece el segundo siguiente.
 * Recupera segundos si el timer se retrasa (hasta 5). Devuelve la funcion para detenerlo.
 */
export function scheduleEngine(
  engine: TimedEngine,
  now: () => number,
  run: (T: number) => void,
  enabled: () => boolean,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastT = 0;
  const d = engine.opts.delayMs;
  const loop = () => {
    const T = Math.floor((now() - d) / 1000) * 1000;
    if (enabled()) {
      if (!lastT || T - lastT > 5000) lastT = T - 1000;
      for (let t = lastT + 1000; t <= T; t += 1000) run(t);
      lastT = T;
    }
    timer = setTimeout(loop, Math.max(5, T + 1000 + d - now()));
  };
  loop();
  return () => clearTimeout(timer);
}
