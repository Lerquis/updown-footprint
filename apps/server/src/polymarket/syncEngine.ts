import { EventEmitter } from "node:events";
import type { AggTrade, CvdPoint, OrderflowSignal, PmDecision, PmEngineMarket, PmMarket, PmPoint, PmSignal } from "@updown/protocol";
import { estimateSigma, flowScore, recentAvg } from "./model.js";
import { DEFAULT_STRATEGY, SignalEngine, type StrategyConfig } from "./strategy.js";

/**
 * Motor B ("sincronizado"): las mismas reglas que el motor principal (A), pero decide en el segundo exacto `T`
 * del reloj de Binance usando solo datos "a fecha" de `T`: el ultimo precio de cada token y de Chainlink con
 * marca de tiempo <= T, y un CVD propio construido con los aggTrades de tiempo < T. Asi dos servidores en
 * lugares distintos ven la misma foto y deberian decidir lo mismo. Solo en memoria (no se guarda en la base).
 * Ver docs/features/signal-engine.md.
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

  /** Ultimo valor con time <= t (o undefined) */
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

  clear(): void {
    this.items = [];
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

export interface SyncEngineEvents {
  decision: [string, PmDecision];
  /** el motor termino un market (sus operaciones, para el historial en memoria) */
  market: [PmEngineMarket];
}

export interface SyncEngineOptions {
  strategy?: StrategyConfig;
  /** memoria de trades/CVD (debe cubrir la volatilidad y la ventana TWAP; igual que RETENTION_MS) */
  retentionMs: number;
  /** markets terminados cuyas operaciones se recuerdan */
  historyMax: number;
  /** decisiones del market en curso que se conservan */
  decisionsMax: number;
}

export class SyncEngine extends EventEmitter<SyncEngineEvents> {
  private readonly quotes = new Map<string, AsOf<{ bid: number | null; ask: number | null }>>();
  private readonly chainlink = new AsOf<number>();
  private readonly cvd: SecondCvd;
  private market: PmMarket | null = null;
  private engine?: SignalEngine;
  private basisEma: number | null = null;
  private lastT = 0;
  decisions: PmDecision[] = [];
  trades: PmSignal[] = [];
  readonly history: PmEngineMarket[] = [];

  constructor(private readonly opts: SyncEngineOptions) {
    super();
    this.cvd = new SecondCvd(opts.retentionMs);
  }

  get slug(): string | null {
    return this.market?.slug ?? null;
  }

  addTrade(t: AggTrade): void {
    this.cvd.add(t);
  }

  onChainlink(time: number, value: number): void {
    this.chainlink.push(time < 1e12 ? time * 1000 : time, value);
  }

  onQuote(token: string, bid: number | null, ask: number | null, time: number): void {
    let q = this.quotes.get(token);
    if (!q) this.quotes.set(token, (q = new AsOf()));
    q.push(time, { bid, ask });
  }

  /**
   * Decide el segundo `T` (multiplo de 1000, reloj de Binance) del market que contenga `T`.
   * `signals`: senales de footprint (las de tiempo > T se ignoran). Devuelve la decision o null si no hay market.
   */
  step(T: number, market: PmMarket | null, signals: OrderflowSignal[]): PmDecision | null {
    if (T <= this.lastT) return null;
    this.lastT = T;
    this.cvd.closeTo(T);
    this.chainlink.prune(T - 60_000);
    for (const q of this.quotes.values()) q.prune(T - 60_000);
    if (!market || T < market.start || T >= market.end) return null;
    if (this.market?.slug !== market.slug) this.rotate(market);

    const cfg = this.opts.strategy ?? DEFAULT_STRATEGY;
    const cvd = this.cvd.points;
    const last = cvd[cvd.length - 1];
    const chain = this.chainlink.at(T) ?? null;
    const avg = recentAvg(cvd, T, cfg.model.twapSeconds);
    const basis = chain !== null && avg !== null ? chain - avg : null;
    if (basis !== null) this.basisEma = this.basisEma === null ? basis : this.basisEma + (1 - Math.pow(0.5, 1 / 60)) * (basis - this.basisEma);
    const up = this.quotes.get(market.upToken)?.at(T);
    const down = this.quotes.get(market.downToken)?.at(T);
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
    this.trades.push(...r.signals);
    this.decisions.push(r.decision);
    if (this.decisions.length > this.opts.decisionsMax) this.decisions.shift();
    this.emit("decision", market.slug, r.decision);
    return r.decision;
  }

  private rotate(market: PmMarket): void {
    if (this.market) {
      const done: PmEngineMarket = { slug: this.market.slug, trades: this.trades };
      this.history.push(done);
      if (this.history.length > this.opts.historyMax) this.history.shift();
      this.emit("market", done);
      // las cotizaciones son por token: las del market anterior ya no sirven
      for (const t of [this.market.upToken, this.market.downToken]) this.quotes.delete(t);
    }
    this.market = market;
    this.engine = new SignalEngine(market, this.opts.strategy ?? DEFAULT_STRATEGY);
    this.decisions = [];
    this.trades = [];
  }
}
