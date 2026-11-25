import type { PmMarket, PmPnl, PmPoint, PmSide, PmSignal } from "@updown/protocol";
import { blend, DEFAULT_MODEL, modelProbUp, takerFee, type ModelConfig } from "./model.js";

/**
 * Reglas de decision del motor (compra / venta / cobertura). Cada segundo evalua el valor esperado (EV) de
 * cada accion contra los precios REALES (ask al comprar, bid al vender) incluyendo comision y deslizamiento.
 * Solo senala si el EV supera un margen: el objetivo es rentabilidad esperada, no acertar el resultado final.
 * Ver docs/features/signal-engine.md.
 */
export interface StrategyConfig {
  model: ModelConfig;
  /** comision de taker (0.05 en BTC 5m/15m) */
  feeRate: number;
  /** deslizamiento supuesto por token al ejecutar (USDC) */
  slippage: number;
  /** EV minimo por token (USDC) para abrir una posicion */
  minEdge: number;
  /** cuanto debe valer mas vender que mantener (por token) para senalar la venta; evita entrar y salir por ruido */
  exitMargin: number;
  /** bankroll de referencia (USDC) para dimensionar */
  bankroll: number;
  /** fraccion de Kelly (0.25 = cuarto de Kelly) */
  kellyFraction: number;
  /** maximo por entrada, fraccion del bankroll */
  maxStakePct: number;
  /** maximo gastado en un mismo market, fraccion del bankroll */
  maxMarketPct: number;
  /** entrada minima (USDC) */
  minStake: number;
  /** segundos desde el inicio sin operar (hace falta price to beat y volatilidad estables) */
  warmupS: number;
  /** segundos finales sin abrir posiciones (latencia / liquidez) */
  noEntryS: number;
  /** spread maximo (ask - bid) para entrar */
  maxSpread: number;
  /** espera (s) entre dos senales del mismo lado */
  cooldownS: number;
  /** maximo de compras por market */
  maxEntries: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  model: DEFAULT_MODEL,
  feeRate: 0.05,
  slippage: 0.005,
  minEdge: 0.04,
  exitMargin: 0.015,
  bankroll: 1000,
  kellyFraction: 0.25,
  maxStakePct: 0.05,
  maxMarketPct: 0.1,
  minStake: 5,
  warmupS: 20,
  noEntryS: 10,
  maxSpread: 0.08,
  cooldownS: 10,
  maxEntries: 4,
};

interface Position {
  shares: number;
  /** USDC pagados (con comision) */
  cost: number;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Estado de decisiones de UN market. Se crea al empezar el market y recibe un punto por segundo. */
export class SignalEngine {
  private pos: Record<PmSide, Position> = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  private lastSignal: Record<PmSide, number> = { up: -Infinity, down: -Infinity };
  private tail = { sum: 0, n: 0 };
  private spent = 0;
  private entries = 0;
  private seq = 0;

  constructor(
    private readonly market: PmMarket,
    private readonly cfg: StrategyConfig = DEFAULT_STRATEGY,
  ) {}

  /**
   * Procesa el punto del segundo. Devuelve la probabilidad de Up (o null si falta algun dato) y las senales
   * emitidas. El punto debe traer `chainlink`, `binance`, `basis`, `sigma` y `flow` (los pone el tracker).
   */
  step(p: PmPoint): { pUp: number | null; signals: PmSignal[] } {
    const m = this.market;
    const { model } = this.cfg;
    const k = m.priceToBeat;
    if (k === null || p.binance === null || p.basis === null || p.sigma === null || p.time >= m.end) return { pUp: null, signals: [] };

    const x = p.binance + p.basis;
    const tau = (m.end - p.time) / 1000;
    if (tau <= model.twapSeconds) {
      this.tail.sum += x;
      this.tail.n++;
    }
    const mid = (bid: number | null, ask: number | null) => (bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask));
    const upMid = mid(p.upBid, p.upAsk);
    const downMid = mid(p.downBid, p.downAsk);
    const pMarket = upMid !== null && downMid !== null ? (upMid + 1 - downMid) / 2 : upMid !== null ? upMid : downMid !== null ? 1 - downMid : null;

    const pModel = modelProbUp({ x, k, tau, sigma: p.sigma, tailAvg: this.tail.n ? this.tail.sum / this.tail.n : null, flow: p.flow ?? 0 }, model);
    const pUp = blend(pModel, pMarket, model.modelWeight);
    return { pUp, signals: this.decide(p, pUp, tau) };
  }

  private decide(p: PmPoint, pUp: number, tau: number): PmSignal[] {
    const c = this.cfg;
    const out: PmSignal[] = [];
    const quote = {
      up: { bid: p.upBid, ask: p.upAsk },
      down: { bid: p.downBid, ask: p.downAsk },
    };
    const prob: Record<PmSide, number> = { up: pUp, down: 1 - pUp };
    const other: Record<PmSide, PmSide> = { up: "down", down: "up" };

    // 1) ventas: vender vale mas que mantener (y tras vender se puede comprar el otro lado)
    const sold: Record<PmSide, boolean> = { up: false, down: false };
    for (const side of ["up", "down"] as const) {
      const pos = this.pos[side];
      const bid = quote[side].bid;
      if (pos.shares <= 0 || bid === null || bid <= 0) continue;
      const sellValue = bid - takerFee(bid, c.feeRate) - c.slippage;
      const edge = sellValue - prob[side];
      if (edge < c.exitMargin || p.time - this.lastSignal[side] < c.cooldownS * 1000) continue;
      sold[side] = true;
      out.push(this.sell(p, side, bid, edge, prob[side], tau));
    }

    // 2) compras: EV neto > margen, con spread razonable, fuera de calentamiento y de los segundos finales
    const elapsed = (this.market.end - this.market.start) / 1000 - tau;
    if (elapsed < c.warmupS || tau < c.noEntryS || this.entries >= c.maxEntries) return out;
    for (const side of ["up", "down"] as const) {
      const { bid, ask } = quote[side];
      if (ask === null || ask <= 0 || ask >= 1 || sold[side]) continue;
      if (bid !== null && ask - bid > c.maxSpread) continue;
      if (this.pos[side].shares > 0) continue; // sin pirámide: una entrada por lado
      if (p.time - this.lastSignal[side] < c.cooldownS * 1000) continue;
      const cost = ask + takerFee(ask, c.feeRate) + c.slippage;
      const edge = prob[side] - cost;
      if (edge < c.minEdge) continue;
      const kelly = edge / (1 - cost);
      const stake = Math.min(c.kellyFraction * kelly * c.bankroll, c.maxStakePct * c.bankroll, c.maxMarketPct * c.bankroll - this.spent);
      if (stake < c.minStake) continue;
      const reason = this.pos[other[side]].shares > 0 ? "hedge" : sold[other[side]] ? "flip" : "entry";
      out.push(this.buy(p, side, ask, cost, stake, edge, prob[side], tau, reason));
    }
    return out;
  }

  private id(p: PmPoint) {
    return `${this.market.slug}:${p.time}:${this.seq++}`;
  }

  private buy(p: PmPoint, side: PmSide, ask: number, cost: number, stake: number, edge: number, pSide: number, tau: number, reason: PmSignal["reason"]): PmSignal {
    const shares = stake / cost;
    const pos = this.pos[side];
    pos.shares += shares;
    pos.cost += stake;
    this.spent += stake;
    this.entries++;
    this.lastSignal[side] = p.time;
    return { id: this.id(p), slug: this.market.slug, time: p.time, action: "buy", side, reason, price: ask, fee: round(takerFee(ask, this.cfg.feeRate), 5), shares: round(shares, 3), amount: round(stake, 2), pSide: round(pSide), edge: round(edge), tau };
  }

  private sell(p: PmPoint, side: PmSide, bid: number, edge: number, pSide: number, tau: number): PmSignal {
    const pos = this.pos[side];
    const fee = takerFee(bid, this.cfg.feeRate);
    const amount = pos.shares * (bid - fee - this.cfg.slippage);
    const shares = pos.shares;
    pos.shares = 0;
    pos.cost = 0;
    this.lastSignal[side] = p.time;
    return { id: this.id(p), slug: this.market.slug, time: p.time, action: "sell", side, reason: "exit", price: bid, fee: round(fee, 5), shares: round(shares, 3), amount: round(amount, 2), pSide: round(pSide), edge: round(edge), tau };
  }
}

/** Resultado paper de una lista de senales. `result` null => aun sin resolver (net/roi null). Funcion pura. */
export function computePnl(trades: PmSignal[], result: "up" | "down" | null): PmPnl {
  let invested = 0;
  let sold = 0;
  const open = { up: 0, down: 0 };
  for (const t of trades) {
    if (t.action === "buy") {
      invested += t.amount;
      open[t.side] += t.shares;
    } else {
      sold += t.amount;
      open[t.side] = Math.max(0, open[t.side] - t.shares);
    }
  }
  const payout = result === null ? null : open[result];
  const net = payout === null ? null : sold + payout - invested;
  return {
    invested: round(invested, 2),
    sold: round(sold, 2),
    openUp: round(open.up, 3),
    openDown: round(open.down, 3),
    net: net === null ? null : round(net, 2),
    roi: net === null || invested <= 0 ? null : round(net / invested),
  };
}

/** Reproduce un market guardado con otra configuracion (calibracion). Usa solo los puntos del propio market. */
export function replayMarket(market: PmMarket, points: PmPoint[], cfg: StrategyConfig = DEFAULT_STRATEGY): { trades: PmSignal[]; pnl: PmPnl } {
  const engine = new SignalEngine(market, cfg);
  const trades: PmSignal[] = [];
  for (const p of points) trades.push(...engine.step(p).signals);
  return { trades, pnl: computePnl(trades, market.result) };
}
