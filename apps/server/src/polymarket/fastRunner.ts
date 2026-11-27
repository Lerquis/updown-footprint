import { EventEmitter } from "node:events";
import type { AggTrade, PmDecision, PmMarket, PmOrder, PmPoint, PmSide, PmSignal } from "@updown/protocol";
import { estimateSigma, recentAvg } from "./model.js";
import { MakerEngine, reconcile, type MakerConfig } from "./maker.js";
import { bookImbalance, driftScore, MicroFlow, predictDrift, type DriftConfig } from "./micro.js";
import { PaperMaker, PaperTaker, type MakerFill, type PaperTakerFill } from "./paper.js";
import { PmBooks, type Level, type PmTrade, type TokenBook } from "./pmBook.js";
import { PredictiveEngine, type FastInput, type PredictiveConfig } from "./predictive.js";
import { SecondCvd, type PmFeed } from "./timedEngine.js";

/**
 * Programa y alimenta los motores D (predictivo, taker) y E (libro, maker): un paso cada `tickMs` (100 ms) con lo ultimo
 * recibido de Binance (trades y libro), Polymarket (libro completo y trades) y Chainlink. Ver docs/features/predictive-engines.md.
 * Una vez por segundo de Binance emite la muestra y el registro de decisiones de cada motor (grafico, base de datos, canal engines).
 */

export type FastEngineId = "d" | "e";

export interface FastRunnerOptions {
  tickMs: number;
  /** memoria de CVD de 1 s (volatilidad y basis) */
  retentionMs: number;
  decisionsMax: number;
  twapSeconds: number;
  /** ventana del basis (s); por defecto twapSeconds */
  basisSeconds?: number;
  predictive: PredictiveConfig;
  maker: MakerConfig;
  drift: DriftConfig;
  /** papel: retraso de una orden taker hasta ejecutarse, de una orden maker hasta entrar al libro, y de una cancelacion */
  paper: { takerLatencyMs: number; postLatencyMs: number; cancelLatencyMs: number };
}

export interface FastStep {
  engine: FastEngineId;
  slug: string;
  point: PmPoint;
  decision: PmDecision;
}

export interface FastRunnerEvents {
  /** muestra y decision de un motor, una vez por segundo */
  step: [FastStep];
  /** operaciones ejecutadas (papel) de un motor */
  fills: [FastEngineId, string, PmSignal[]];
  /** ordenes que el motor D envia ahora (las compras reales las siguen si se elige D) */
  intent: [PmSignal[], PmMarket];
  /** orden en reposo del motor E nueva o actualizada */
  order: [string, PmOrder];
}

interface MarketState {
  market: PmMarket;
  d: PredictiveEngine;
  e: MakerEngine;
  taker: PaperTaker;
  maker: PaperMaker;
  /** a que motor pertenece cada orden taker en papel */
  owner: Map<string, FastEngineId>;
  /** senales decididas desde la ultima muestra (para el registro del segundo) */
  decided: Record<FastEngineId, PmSignal[]>;
  last: Record<FastEngineId, PmDecision | null>;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export class FastRunner extends EventEmitter<FastRunnerEvents> {
  readonly books = new PmBooks();
  private readonly cvd: SecondCvd;
  private readonly micro = new MicroFlow();
  private st: MarketState | null = null;
  private basisEma: number | null = null;
  private sigma: number | null = null;
  private sec = 0;
  private lastPointSec = 0;
  /** decisiones del market en curso de cada motor (para el canal engines) */
  readonly decisions: Record<FastEngineId, PmDecision[]> = { d: [], e: [] };

  constructor(
    readonly opts: FastRunnerOptions,
    private readonly feed: PmFeed,
    /** libro de Binance (para el desequilibrio); null si aun no esta listo */
    private readonly binanceBook: () => { bids: Iterable<[number, number]>; asks: Iterable<[number, number]>; mid: number } | null,
  ) {
    super();
    this.cvd = new SecondCvd(opts.retentionMs);
  }

  get slug(): string | null {
    return this.st?.market.slug ?? null;
  }

  /** Ordenes del motor E en el market en curso */
  orders(): PmOrder[] {
    return this.st?.maker.all() ?? [];
  }

  addTrade(t: AggTrade): void {
    this.cvd.add(t);
    this.micro.add(t);
  }

  // ── libro y trades de Polymarket (del tracker) ──
  onBook(token: string, bids: Level[], asks: Level[], time: number): void {
    this.books.get(token).snapshot(bids, asks, time);
  }

  onLevel(token: string, side: "bid" | "ask", price: number, size: number, time: number, now: number): void {
    this.books.get(token).set(side, price, size, time);
    if (this.st) this.makerFills(this.st.maker.onLevel(token, side, price, size, now));
  }

  onTrade(t: PmTrade, now: number): void {
    if (this.st) this.makerFills(this.st.maker.onTrade(t, now));
  }

  private token(m: PmMarket, side: PmSide): string {
    return side === "up" ? m.upToken : m.downToken;
  }

  private book = (token: string): TokenBook | null => (token && this.books.has(token) ? this.books.get(token) : null);

  private quote(token: string): { bid: number | null; ask: number | null } {
    const b = this.book(token);
    if (b && b.time > 0) return { bid: b.bestBid(), ask: b.bestAsk() };
    const q = this.feed.quote(token, Infinity);
    return { bid: q?.bid ?? null, ask: q?.ask ?? null };
  }

  /** Un paso: `now` en el reloj de Binance, `market` el que contiene `now` (o null). */
  tick(now: number, market: PmMarket | null): void {
    this.cvd.closeTo(now);
    const sec = Math.floor(now / 1000);
    if (sec !== this.sec) {
      this.sec = sec;
      // basis y volatilidad: una vez por segundo, igual que A y C
      const chain = this.feed.chainlink.at(Infinity) ?? null;
      const avg = recentAvg(this.cvd.points, sec * 1000, this.opts.basisSeconds ?? this.opts.twapSeconds);
      const basis = chain !== null && avg !== null ? chain - avg : null;
      if (basis !== null) this.basisEma = this.basisEma === null ? basis : this.basisEma + (1 - Math.pow(0.5, 1 / 60)) * (basis - this.basisEma);
      this.sigma = estimateSigma(this.cvd.points);
    }
    if (this.st && (!market || market.slug !== this.st.market.slug)) this.closeMarket(now);
    if (!market || now < market.start || now >= market.end) return;
    if (!this.st) this.openMarket(market);
    const st = this.st!;
    const m = st.market;

    // ── entradas ──
    const last = this.micro.lastPrice;
    const lastTime = this.micro.lastTime;
    const binance = last !== null && lastTime !== null && now - lastTime <= 3000 ? last : null;
    const bb = this.binanceBook();
    const imb = bb ? bookImbalance(bb.bids, bb.asks, bb.mid, this.opts.drift.bookRangeUsd) : 0;
    const f = this.micro.features(now, this.sigma, imb);
    const tau = (m.end - now) / 1000;
    const z = f ? driftScore(f, this.opts.drift) : 0;
    const drift = f && this.sigma ? predictDrift(f, this.sigma, tau, this.opts.drift) : 0;
    const input: FastInput = {
      time: now,
      binance,
      basis: this.basisEma,
      chainlink: this.feed.chainlink.at(Infinity) ?? null,
      sigma: this.sigma,
      drift,
      z,
      up: this.quote(m.upToken),
      down: this.quote(m.downToken),
    };

    // ── motor D: ordenes taker con limite ──
    const d = st.d.step(input);
    if (d.signals.length) {
      st.decided.d.push(...d.signals);
      this.emit("intent", d.signals, m);
      for (const s of d.signals) {
        st.owner.set(s.id, "d");
        st.taker.submit(s, this.token(m, s.side), now);
      }
    }
    st.last.d = d.decision;

    // ── motor E: cotizaciones en reposo + salida de emergencia ──
    const e = st.e.step(input, st.maker.open());
    for (const s of e.signals) {
      st.decided.e.push(s);
      st.owner.set(s.id, "e");
      st.taker.submit(s, this.token(m, s.side), now);
    }
    for (const a of reconcile(st.maker.all(), e.wants, now, this.opts.maker)) {
      if (a.type === "cancel") st.maker.cancel(a.id, now, a.reason);
      else st.maker.place(a.side, a.action, a.price, a.shares, this.token(m, a.side), now);
    }
    st.last.e = e.decision;

    // ── papel: entradas al libro, cancelaciones y ejecuciones taker vencidas ──
    st.maker.advance(now, this.book);
    this.takerFills(st.taker.resolve(now, this.book, m.end));
    this.emitOrders();

    // ── una muestra por segundo de Binance ──
    if (sec > this.lastPointSec) {
      this.lastPointSec = sec;
      const point = (pUp: number | null): PmPoint => ({
        time: sec * 1000,
        chainlink: input.chainlink,
        upBid: input.up.bid,
        upAsk: input.up.ask,
        downBid: input.down.bid,
        downAsk: input.down.ask,
        binance,
        basis: this.basisEma,
        sigma: this.sigma,
        flow: round(Math.max(-1, Math.min(1, this.opts.drift.gain * z))),
        pModel: pUp,
        drift: f ? round(drift, 2) : null,
      });
      for (const id of ["d", "e"] as const) {
        const dec = st.last[id]!;
        const decision = { ...dec, signals: st.decided[id] };
        st.decided[id] = [];
        this.decisions[id].push(decision);
        if (this.decisions[id].length > this.opts.decisionsMax) this.decisions[id].shift();
        this.emit("step", { engine: id, slug: m.slug, point: point(dec.pUp), decision });
      }
    }
  }

  private openMarket(market: PmMarket): void {
    this.st = {
      market,
      d: new PredictiveEngine(market, this.opts.predictive),
      e: new MakerEngine(market, this.opts.maker),
      taker: new PaperTaker(this.opts.paper.takerLatencyMs, this.opts.predictive.feeRate, this.opts.predictive.feeKind),
      maker: new PaperMaker(market.slug, { postLatencyMs: this.opts.paper.postLatencyMs, cancelLatencyMs: this.opts.paper.cancelLatencyMs }),
      owner: new Map(),
      decided: { d: [], e: [] },
      last: { d: null, e: null },
    };
    this.decisions.d = [];
    this.decisions.e = [];
  }

  /** Fin del market: se cancela todo lo que queda en el libro y lo pendiente no se ejecuta. */
  private closeMarket(now: number): void {
    const st = this.st!;
    st.maker.cancelAll(now, "market");
    this.takerFills(st.taker.drop());
    this.emitOrders();
    this.st = null;
  }

  private takerFills(fills: PaperTakerFill[]): void {
    const st = this.st;
    if (!st || !fills.length) return;
    const done: Record<FastEngineId, PmSignal[]> = { d: [], e: [] };
    for (const f of fills) {
      const id = st.owner.get(f.signal.id) ?? "d";
      st.owner.delete(f.signal.id);
      const fill = f.filled ? { shares: f.shares, usd: f.usd } : null;
      if (id === "d") st.d.onFill(f.signal.id, fill);
      else st.e.onFill(f.signal.id, fill);
      if (f.filled) done[id].push(f.filled);
    }
    for (const id of ["d", "e"] as const) if (done[id].length) this.emit("fills", id, st.market.slug, done[id]);
  }

  private makerFills(fills: MakerFill[]): void {
    const st = this.st;
    if (!st || !fills.length) return;
    const sigs = fills.map((f) => st.e.onMakerFill(f.order, f.shares, f.time));
    this.emit("fills", "e", st.market.slug, sigs);
    this.emitOrders();
  }

  private emitOrders(): void {
    const st = this.st;
    if (!st) return;
    for (const o of st.maker.takeChanged()) this.emit("order", st.market.slug, o);
  }
}

/** Programa el runner cada `tickMs` sobre el reloj de Binance. Devuelve la funcion para detenerlo. */
export function scheduleFast(runner: FastRunner, now: () => number, run: (t: number) => void, enabled: () => boolean): () => void {
  const timer = setInterval(() => {
    if (enabled()) run(now());
  }, runner.opts.tickMs);
  return () => clearInterval(timer);
}
