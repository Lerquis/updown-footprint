import type { PmBlock, PmDecision, PmMarket, PmSide, PmSideDecision, PmSignal } from "@updown/protocol";
import { blend, DEFAULT_MODEL, modelProbUp, takerFee, type ModelConfig } from "./model.js";

/**
 * Motor D: predictivo (taker). Ver docs/features/predictive-engines.md.
 *
 * El motor A gana en papel porque compra antes de que Polymarket se reajuste a Binance, pero una orden real tarda 1-5 s en
 * registrarse y en ese tiempo el precio ya se movio (replays: +421 USDC con ejecucion inmediata, +26 con 1 s, -91 con 2 s).
 * D ataca las tres causas:
 *  1. Anticipa: la probabilidad usa la deriva prevista por el flujo de Binance (OFI, momentum, libro; `micro.ts`), no solo el
 *     precio actual, y decide cada 100 ms con lo ultimo recibido en vez de una vez por segundo.
 *  2. Exige mas margen (EV >= 10c): con 1-3 s de retraso solo sobrevive la ventaja grande (backtest fuera de muestra).
 *  3. Precio limite: compra solo mientras el precio siga dejando EV positivo (`limit`); si el mercado ya se movio, la orden no
 *     se ejecuta en vez de ejecutarse cara. Su papel tambien se ejecuta con retraso contra el libro real (`paper.ts`).
 */

export interface FastModelConfig {
  model: ModelConfig;
  /** peso del modelo al mezclar con el mercado (logit) */
  modelWeight: number;
  /** peso del modelo en los ultimos `endTauS` s (ahi el mercado conoce mejor el TWAP final: log loss 0,023 frente a 0,043) */
  modelWeightEnd: number;
  endTauS: number;
}

export const DEFAULT_FAST_MODEL: FastModelConfig = { model: { ...DEFAULT_MODEL, flowGain: 0 }, modelWeight: 0.6, modelWeightEnd: 0.3, endTauS: 30 };

/** Lo que reciben los motores D y E en cada paso (cada 100 ms) */
export interface FastInput {
  /** reloj de Binance, ms (no alineado al segundo) */
  time: number;
  /** ultimo precio de Binance (fresco: <= 3 s) */
  binance: number | null;
  /** Chainlink (TWAP) - media de 60 s de Binance, suavizado */
  basis: number | null;
  chainlink: number | null;
  /** USD por raiz de segundo */
  sigma: number | null;
  /** deriva esperada (USD) y prediccion lineal (sigmas) del flujo de Binance */
  drift: number;
  z: number;
  up: { bid: number | null; ask: number | null };
  down: { bid: number | null; ask: number | null };
}

export interface FairValue {
  pModel: number;
  pMarket: number | null;
  pUp: number;
  tau: number;
}

const mid = (bid: number | null, ask: number | null) => (bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask));

/** Probabilidad de Up con deriva y mezcla con el mercado. Lleva la media del TWAP final ya transcurrido (un valor por segundo). */
export class FairModel {
  private tail = { sum: 0, n: 0 };
  private tailSec = 0;

  constructor(
    private readonly market: PmMarket,
    private readonly cfg: FastModelConfig = DEFAULT_FAST_MODEL,
  ) {}

  update(i: FastInput): FairValue | null {
    const m = this.market;
    const k = m.priceToBeat;
    const tau = (m.end - i.time) / 1000;
    if (k === null || i.binance === null || i.basis === null || i.sigma === null || tau <= 0) return null;
    const x = i.binance + i.basis;
    const sec = Math.floor(i.time / 1000);
    if (tau <= this.cfg.model.twapSeconds && sec !== this.tailSec) {
      this.tailSec = sec;
      this.tail.sum += x;
      this.tail.n++;
    }
    const pModel = modelProbUp({ x: x + i.drift, k, tau, sigma: i.sigma, tailAvg: this.tail.n ? this.tail.sum / this.tail.n : null, flow: 0 }, this.cfg.model);
    const um = mid(i.up.bid, i.up.ask);
    const dm = mid(i.down.bid, i.down.ask);
    const pMarket = um !== null && dm !== null ? (um + 1 - dm) / 2 : um !== null ? um : dm !== null ? 1 - dm : null;
    const w = tau < this.cfg.endTauS ? this.cfg.modelWeightEnd : this.cfg.modelWeight;
    return { pModel, pMarket, pUp: blend(pModel, pMarket, w), tau };
  }
}

export interface PredictiveConfig {
  fair: FastModelConfig;
  feeRate: number;
  /** deslizamiento supuesto al evaluar (el papel se ejecuta luego contra el libro real) */
  slippage: number;
  /** EV minimo por token al precio actual para comprar */
  minEdge: number;
  /** limite de compra = P(lado) - comision - limitMargin: aun ejecutandose al limite queda este EV */
  limitMargin: number;
  /** vender cuando bid - comision - deslizamiento - P(lado) >= exitMargin */
  exitMargin: number;
  maxSpread: number;
  warmupS: number;
  /** segundos finales sin abrir (la orden tarda en registrarse) */
  noEntryS: number;
  cooldownS: number;
  /** compras por lado en un market */
  maxEntriesPerSide: number;
  bankroll: number;
  kellyFraction: number;
  maxStakePct: number;
  maxMarketPct: number;
  minStake: number;
  tick: number;
  /** precios fuera de [minPrice, maxPrice] no se compran (sin recorrido) */
  minPrice: number;
  maxPrice: number;
}

/** Parametros del backtest fuera de muestra (EV 10c, limite 3c, salida 3c; ver docs) */
export const DEFAULT_PREDICTIVE: PredictiveConfig = {
  fair: DEFAULT_FAST_MODEL,
  feeRate: 0.05,
  slippage: 0.005,
  minEdge: 0.1,
  limitMargin: 0.03,
  exitMargin: 0.03,
  maxSpread: 0.08,
  warmupS: 20,
  noEntryS: 20,
  cooldownS: 5,
  maxEntriesPerSide: 1,
  bankroll: 1000,
  kellyFraction: 0.25,
  maxStakePct: 0.05,
  maxMarketPct: 0.1,
  minStake: 5,
  tick: 0.01,
  minPrice: 0.03,
  maxPrice: 0.97,
};

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const r4 = (v: number | null) => (v === null ? null : round(v));
export const floorTick = (p: number, tick: number) => Math.floor(round(p / tick, 6)) * tick;
export const ceilTick = (p: number, tick: number) => Math.ceil(round(p / tick, 6)) * tick;

/** Resultado de un paso de D o E */
export interface FastStepResult {
  fair: FairValue | null;
  /** D: ordenes a enviar (precio = el del libro al decidir, `limit` = peor precio aceptado) */
  signals: PmSignal[];
  decision: PmDecision;
}

/** Ejecucion (simulada o real) de una orden taker */
export interface TakerFill {
  shares: number;
  /** compra: USDC pagados con comision · venta: USDC recibidos netos */
  usd: number;
}

interface Position {
  shares: number;
  cost: number;
}

/** Registro informativo de un paso (mismo formato que A y C) */
export function fastDecision(i: FastInput, fair: FairValue | null, up: PmSideDecision, down: PmSideDecision, signals: PmSignal[], tau: number): PmDecision {
  return {
    time: i.time,
    tau: round(tau, 1),
    chainlink: i.chainlink,
    upBid: i.up.bid,
    upAsk: i.up.ask,
    downBid: i.down.bid,
    downAsk: i.down.ask,
    pModel: r4(fair?.pModel ?? null),
    pMarket: r4(fair?.pMarket ?? null),
    pUp: r4(fair?.pUp ?? null),
    up,
    down,
    signals,
  };
}

/** Motor D de UN market. Recibe un `FastInput` por paso; la posicion solo cambia con `onFill` (ejecuciones, no intenciones). */
export class PredictiveEngine {
  private readonly fairModel: FairModel;
  private pos: Record<PmSide, Position> = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  /** orden enviada y aun sin resultado, por lado */
  private pending: Record<PmSide, string | null> = { up: null, down: null };
  private pendingSignals = new Map<string, PmSignal>();
  private lastSignal: Record<PmSide, number> = { up: -Infinity, down: -Infinity };
  private entries: Record<PmSide, number> = { up: 0, down: 0 };
  private spent = 0;
  private seq = 0;

  constructor(
    private readonly market: PmMarket,
    private readonly cfg: PredictiveConfig = DEFAULT_PREDICTIVE,
  ) {
    this.fairModel = new FairModel(market, cfg.fair);
  }

  /** Tokens en cartera de un lado (de las ejecuciones) */
  shares(side: PmSide): number {
    return this.pos[side].shares;
  }

  step(i: FastInput): FastStepResult {
    const m = this.market;
    const c = this.cfg;
    const tau = (m.end - i.time) / 1000;
    const fair = this.fairModel.update(i);
    const ev: Record<PmSide, PmSideDecision> = {
      up: { shares: round(this.pos.up.shares, 3), buyEdge: null, buy: "ok", sellEdge: null, sell: this.pos.up.shares > 0 ? "ok" : "flat" },
      down: { shares: round(this.pos.down.shares, 3), buyEdge: null, buy: "ok", sellEdge: null, sell: this.pos.down.shares > 0 ? "ok" : "flat" },
    };
    if (!fair) {
      for (const s of ["up", "down"] as const) {
        ev[s].buy = "noData";
        if (this.pos[s].shares > 0) ev[s].sell = "noData";
      }
      return { fair, signals: [], decision: fastDecision(i, null, ev.up, ev.down, [], tau) };
    }
    const prob: Record<PmSide, number> = { up: fair.pUp, down: 1 - fair.pUp };
    const quote = { up: i.up, down: i.down };
    const out: PmSignal[] = [];
    const block = (s: PmSide, b: PmBlock) => {
      if (ev[s].buy === "ok") ev[s].buy = b;
    };

    // 1) ventas: vender vale mas que mantener hasta el pago, con limite que conserva parte del margen
    for (const s of ["up", "down"] as const) {
      const pos = this.pos[s];
      if (pos.shares <= 0) continue;
      const bid = quote[s].bid;
      if (this.pending[s]) {
        ev[s].sell = "pending";
        continue;
      }
      if (bid === null || bid <= 0) {
        ev[s].sell = "noQuote";
        continue;
      }
      const fee = takerFee(bid, c.feeRate);
      const edge = bid - fee - c.slippage - prob[s];
      ev[s].sellEdge = round(edge);
      if (edge < c.exitMargin) {
        ev[s].sell = "edge";
        continue;
      }
      if (i.time - this.lastSignal[s] < c.cooldownS * 1000) {
        ev[s].sell = "cooldown";
        continue;
      }
      const limit = Math.max(c.tick, ceilTick(prob[s] + fee + c.exitMargin / 2, c.tick));
      out.push(this.signal(i, s, "sell", "exit", bid, pos.shares, pos.shares * (bid - fee - c.slippage), prob[s], edge, tau, Math.min(limit, bid)));
    }

    // 2) compras
    for (const s of ["up", "down"] as const) {
      const ask = quote[s].ask;
      if (ask !== null && ask > 0 && ask < 1) ev[s].buyEdge = round(prob[s] - (ask + takerFee(ask, c.feeRate) + c.slippage));
    }
    const elapsed = (m.end - m.start) / 1000 - tau;
    const global: PmBlock | null = elapsed < c.warmupS ? "warmup" : tau < c.noEntryS ? "closing" : null;
    for (const s of ["up", "down"] as const) {
      const { bid, ask } = quote[s];
      if (global) {
        block(s, ask === null ? "noQuote" : global);
        continue;
      }
      if (ask === null || ask < c.minPrice || ask > c.maxPrice) {
        block(s, "noQuote");
        continue;
      }
      if (out.some((x) => x.side === s)) {
        block(s, "justSold");
        continue;
      }
      if (this.pending[s]) {
        block(s, "pending");
        continue;
      }
      if (bid !== null && ask - bid > c.maxSpread) {
        block(s, "spread");
        continue;
      }
      if (this.pos[s].shares > 0) {
        block(s, "holding");
        continue;
      }
      if (this.entries[s] >= c.maxEntriesPerSide) {
        block(s, "maxEntries");
        continue;
      }
      if (i.time - this.lastSignal[s] < c.cooldownS * 1000) {
        block(s, "cooldown");
        continue;
      }
      const fee = takerFee(ask, c.feeRate);
      const cost = ask + fee + c.slippage;
      const edge = prob[s] - cost;
      if (edge < c.minEdge) {
        block(s, "edge");
        continue;
      }
      const limit = Math.min(c.maxPrice, floorTick(prob[s] - fee - c.limitMargin, c.tick));
      const kelly = edge / (1 - cost);
      const stake = Math.min(c.kellyFraction * kelly * c.bankroll, c.maxStakePct * c.bankroll, c.maxMarketPct * c.bankroll - this.spent);
      if (stake < c.minStake || limit < ask) {
        block(s, "stake");
        continue;
      }
      const other: PmSide = s === "up" ? "down" : "up";
      const reason = this.pos[other].shares > 0 ? "hedge" : out.some((x) => x.side === other) ? "flip" : "entry";
      out.push(this.signal(i, s, "buy", reason, ask, stake / cost, stake, prob[s], edge, tau, limit));
    }
    return { fair, signals: out, decision: fastDecision(i, fair, ev.up, ev.down, out, tau) };
  }

  private signal(i: FastInput, side: PmSide, action: "buy" | "sell", reason: PmSignal["reason"], price: number, shares: number, amount: number, pSide: number, edge: number, tau: number, limit: number): PmSignal {
    const s: PmSignal = {
      id: `${this.market.slug}:d:${i.time}:${this.seq++}`,
      slug: this.market.slug,
      time: i.time,
      action,
      side,
      reason,
      price,
      fee: round(takerFee(price, this.cfg.feeRate), 5),
      shares: round(shares, 3),
      amount: round(amount, 2),
      pSide: round(pSide),
      edge: round(edge),
      tau: round(tau, 1),
      limit: round(limit, 4),
    };
    this.pending[side] = s.id;
    this.pendingSignals.set(s.id, s);
    this.lastSignal[side] = i.time;
    if (action === "buy") {
      this.entries[side]++;
      this.spent += amount; // se reserva; si no se ejecuta, se devuelve en onFill
    }
    return s;
  }

  /** Resultado de una orden enviada: `fill` null o con 0 tokens = no se ejecuto (el limite la protegio). */
  onFill(signalId: string, fill: TakerFill | null): void {
    const s = this.pendingSignals.get(signalId);
    if (!s) return;
    this.pendingSignals.delete(signalId);
    if (this.pending[s.side] === signalId) this.pending[s.side] = null;
    const pos = this.pos[s.side];
    const got = fill && fill.shares > 0 ? fill : null;
    if (s.action === "buy") {
      this.spent += (got?.usd ?? 0) - s.amount;
      if (!got) {
        this.entries[s.side]--; // sin ejecucion: puede reintentar tras la espera
        return;
      }
      pos.shares += got.shares;
      pos.cost += got.usd;
    } else if (got) {
      const frac = pos.shares > 0 ? Math.min(1, got.shares / pos.shares) : 1;
      pos.cost *= 1 - frac;
      pos.shares = Math.max(0, pos.shares - got.shares);
      if (pos.shares < 1e-6) pos.shares = 0;
    }
  }
}
