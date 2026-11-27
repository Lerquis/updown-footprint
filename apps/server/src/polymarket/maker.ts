import type { PmBlock, PmCancelReason, PmMarket, PmOrder, PmSide, PmSideDecision, PmSignal } from "@updown/protocol";
import { takerFee, type FeeKind } from "./model.js";
import { ceilTick, DEFAULT_FAST_MODEL, FairModel, fastDecision, floorTick, type FastInput, type FastModelConfig, type FastStepResult, type TakerFill } from "./predictive.js";

/**
 * Motor E: libro de ordenes (maker). Ver docs/features/predictive-engines.md.
 *
 * En vez de perseguir el precio (taker, 1-5 s tarde), deja ordenes limite en reposo donde, si se ejecutan, el EV es positivo y sin
 * comision (los makers no pagan). El riesgo del maker es la seleccion adversa: te ejecutan justo cuando el precio va en tu contra.
 * Se controla con lo que hace a este servidor mas rapido que el libro de Polymarket:
 *  - Binance va por delante de Polymarket varios segundos: se cancela en cuanto la probabilidad cae, el flujo se gira o el EV
 *    ya no alcanza (cancelar tarda ~50-100 ms; las ordenes taker de los demas se retienen 150-250 ms en estos markets).
 *  - Solo cotiza la entrada de un lado si el flujo de Binance empuja a favor de ese lado (`needDrift`).
 *  - Reposiciones: si el precio deseado cambia >= `repriceMin`, cancela y coloca de nuevo (con un tiempo minimo en el libro).
 *  - Salida tambien como maker (ask en reposo por encima del valor) y salida de emergencia taker si la idea murio (`stop`).
 * En los backtests con muestras de 1 s, cancelar rapido fue la diferencia entre -26 % y ~0 %; la prueba real es el papel en vivo
 * (`paper.ts`), que simula la cola del libro con los trades de Polymarket.
 */

export interface MakerConfig {
  fair: FastModelConfig;
  feeRate: number;
  /** formula de la comision (por defecto la de Polymarket) */
  feeKind?: FeeKind;
  slippage: number;
  /** la compra en reposo esta como maximo a P(lado) - edge */
  edge: number;
  /** se cancela si P(lado) - precio < edge * cancelEdgeFrac */
  cancelEdgeFrac: number;
  /** z del flujo a favor del lado (sigmas) para cotizar la entrada; se cancela si baja de needDrift - driftHysteresis */
  needDrift: number;
  driftHysteresis: number;
  /** se cancela si P(lado) cayo mas que esto en el ultimo segundo */
  dropCancel: number;
  /**
   * la compra mejora el mejor bid como mucho en `join` (0 = se une al mejor bid). Con 1 tick, si el spread lo permite queda
   * sola en un nivel nuevo, primera de la cola (al unirse al mejor bid suele haber cientos de tokens por delante).
   */
  join: number;
  /** venta en reposo a >= P(lado) + exitEdge */
  exitEdge: number;
  /** salida taker si P(lado) cae por debajo del precio de entrada - stop */
  stop: number;
  /** cambio minimo de precio deseado para recolocar */
  repriceMin: number;
  /** tiempo minimo en el libro antes de recolocar (las cancelaciones de riesgo no esperan) */
  minRestMs: number;
  warmupS: number;
  noEntryS: number;
  /** compras ejecutadas por lado en un market */
  maxEntriesPerSide: number;
  bankroll: number;
  kellyFraction: number;
  maxStakePct: number;
  maxMarketPct: number;
  minStake: number;
  tick: number;
  minPrice: number;
  maxPrice: number;
}

export const DEFAULT_MAKER: MakerConfig = {
  fair: DEFAULT_FAST_MODEL,
  feeRate: 0.05,
  slippage: 0.005,
  edge: 0.05,
  cancelEdgeFrac: 0.5,
  needDrift: 0.05,
  driftHysteresis: 0.05,
  dropCancel: 0.01,
  join: 0.01,
  exitEdge: 0.04,
  stop: 0.15,
  repriceMin: 0.02,
  minRestMs: 500,
  warmupS: 20,
  noEntryS: 20,
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

/** Cotizacion deseada de un lado (o el motivo por el que no se quiere ninguna) */
export type Want = { price: number; shares: number } | { cancel: PmCancelReason };

export interface MakerWants {
  /** compra en reposo (entrada) y venta en reposo (salida) por lado */
  bid: Record<PmSide, Want>;
  ask: Record<PmSide, Want>;
}

/** Accion sobre el libro que resulta de comparar lo deseado con las ordenes abiertas */
export type BookAction = { type: "place"; side: PmSide; action: "buy" | "sell"; price: number; shares: number } | { type: "cancel"; id: string; reason: PmCancelReason };

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const live = (o: PmOrder) => o.status === "pending" || o.status === "open";

/**
 * Compara las ordenes vivas (no canceladas) con lo deseado: cancela lo que sobra (con su motivo), recoloca si el precio deseado
 * se aleja >= repriceMin tras minRestMs en el libro, y coloca lo que falta. Funcion pura.
 */
export function reconcile(orders: PmOrder[], wants: MakerWants, now: number, cfg: Pick<MakerConfig, "repriceMin" | "minRestMs">): BookAction[] {
  const out: BookAction[] = [];
  for (const side of ["up", "down"] as const) {
    for (const action of ["buy", "sell"] as const) {
      const want = (action === "buy" ? wants.bid : wants.ask)[side];
      const mine = orders.filter((o) => o.side === side && o.action === action && live(o) && o.cancelAt === null);
      let keep = false;
      let cancelled = false;
      for (const o of mine) {
        if ("cancel" in want) out.push({ type: "cancel", id: o.id, reason: want.cancel });
        else if (!keep && Math.abs(o.price - want.price) < cfg.repriceMin - 1e-9) keep = true;
        else if (!keep && now - o.placedAt < cfg.minRestMs) keep = true; // aun no toca recolocar
        else {
          out.push({ type: "cancel", id: o.id, reason: "reprice" });
          cancelled = true;
        }
      }
      // reposicion = cancelar y, cuando la cancelacion se confirma, colocar: nunca dos ordenes vivas del mismo lado a la vez
      const cancelling = cancelled || orders.some((o) => o.side === side && o.action === action && live(o) && o.cancelAt !== null);
      if (!keep && !("cancel" in want) && !cancelling) out.push({ type: "place", side, action, price: want.price, shares: want.shares });
    }
  }
  return out;
}

interface Position {
  shares: number;
  cost: number;
}

export interface MakerStep extends FastStepResult {
  wants: MakerWants;
}

/** Motor E de UN market. Decide las cotizaciones; la posicion cambia con `onMakerFill` / `onFill` (ejecuciones simuladas o reales). */
export class MakerEngine {
  private readonly fairModel: FairModel;
  private pos: Record<PmSide, Position> = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  private entries: Record<PmSide, number> = { up: 0, down: 0 };
  private spent = 0;
  /** P(Up) reciente para medir la caida del ultimo segundo */
  private hist: { time: number; pUp: number }[] = [];
  private stopPending: Record<PmSide, string | null> = { up: null, down: null };
  private seq = 0;
  /** ejecuciones por orden y ms (ids unicos de las senales de ejecucion) */
  private fillIds = new Map<string, number>();
  private last: { pSide: Record<PmSide, number>; tau: number } | null = null;

  constructor(
    private readonly market: PmMarket,
    private readonly cfg: MakerConfig = DEFAULT_MAKER,
  ) {
    this.fairModel = new FairModel(market, cfg.fair);
  }

  shares(side: PmSide): number {
    return this.pos[side].shares;
  }

  /** `open`: ordenes del motor aun vivas (para informar de su estado en el registro). */
  step(i: FastInput, open: PmOrder[]): MakerStep {
    const m = this.market;
    const c = this.cfg;
    const tau = (m.end - i.time) / 1000;
    const fair = this.fairModel.update(i);
    const none = (r: PmCancelReason): Want => ({ cancel: r });
    const wants: MakerWants = { bid: { up: none("edge"), down: none("edge") }, ask: { up: none("edge"), down: none("edge") } };
    const ev: Record<PmSide, PmSideDecision> = {
      up: { shares: round(this.pos.up.shares, 3), buyEdge: null, buy: "ok", sellEdge: null, sell: this.pos.up.shares > 0 ? "ok" : "flat" },
      down: { shares: round(this.pos.down.shares, 3), buyEdge: null, buy: "ok", sellEdge: null, sell: this.pos.down.shares > 0 ? "ok" : "flat" },
    };
    const signals: PmSignal[] = [];
    if (!fair || i.time >= m.end) {
      for (const s of ["up", "down"] as const) {
        ev[s].buy = "noData";
        wants.bid[s] = none(i.time >= m.end ? "market" : "edge");
        wants.ask[s] = none(i.time >= m.end ? "market" : "edge");
      }
      return { fair, signals, wants, decision: fastDecision(i, fair, ev.up, ev.down, signals, tau) };
    }
    this.hist.push({ time: i.time, pUp: fair.pUp });
    while (this.hist.length > 1 && this.hist[1]!.time <= i.time - 1000) this.hist.shift();
    const ago = this.hist[0]!;
    const prob: Record<PmSide, number> = { up: fair.pUp, down: 1 - fair.pUp };
    this.last = { pSide: prob, tau };
    const elapsed = (m.end - m.start) / 1000 - tau;
    const quote = { up: i.up, down: i.down };

    for (const s of ["up", "down"] as const) {
      const sgn = s === "up" ? 1 : -1;
      const pS = prob[s];
      const drop = sgn * (ago.pUp - fair.pUp); // > 0: el lado perdio probabilidad en el ultimo segundo
      const zS = sgn * i.z;
      const { bid, ask } = quote[s];
      const pos = this.pos[s];
      const entryOrder = open.find((o) => o.side === s && o.action === "buy" && o.cancelAt === null);

      // ── salida ──
      if (pos.shares > 0) {
        const entry = pos.cost / pos.shares;
        if (pS < entry - c.stop && bid !== null && bid > 0 && !this.stopPending[s]) {
          // la idea murio: salir ya (taker) con limite que acota la perdida
          const fee = takerFee(bid, c.feeRate, c.feeKind);
          wants.ask[s] = none("stop");
          ev[s].sell = "ok";
          ev[s].sellEdge = round(bid - fee - c.slippage - pS);
          signals.push(this.stopSignal(i, s, bid, pS, tau));
        } else if (this.stopPending[s]) {
          ev[s].sell = "pending";
          wants.ask[s] = none("stop");
        } else {
          const want = Math.min(0.99, Math.max(ceilTick(pS + c.exitEdge, c.tick), bid !== null ? round(bid + c.tick) : 0));
          wants.ask[s] = { price: round(want), shares: Math.floor(pos.shares * 100) / 100 };
          ev[s].sellEdge = round(want - pS);
          ev[s].sell = "quoting";
        }
      } else wants.ask[s] = none("edge");

      // ── entrada ──
      const blockWith = (b: PmBlock, r: PmCancelReason) => {
        ev[s].buy = b;
        wants.bid[s] = none(r);
      };
      if (ask !== null && ask > 0 && ask < 1) ev[s].buyEdge = round(pS - (bid !== null ? bid : ask));
      if (elapsed < c.warmupS) blockWith("warmup", "edge");
      else if (tau < c.noEntryS) blockWith("closing", "closing");
      else if (bid === null || ask === null) blockWith("noQuote", "edge");
      else if (pos.shares > 0) blockWith("holding", "edge");
      else if (this.entries[s] >= c.maxEntriesPerSide) blockWith("maxEntries", "edge");
      else if (drop > c.dropCancel) blockWith("drift", "drop");
      else if (zS < c.needDrift - (entryOrder ? c.driftHysteresis : 0)) blockWith("drift", "drift");
      else {
        const price = round(Math.min(floorTick(pS - c.edge, c.tick), round(bid + c.join), round(ask - c.tick)));
        const minEdge = entryOrder ? c.edge * c.cancelEdgeFrac : c.edge;
        const keepPrice = entryOrder && pS - entryOrder.price >= minEdge && Math.abs(entryOrder.price - price) < c.repriceMin ? entryOrder.price : price;
        const edge = pS - keepPrice;
        if (keepPrice < c.minPrice || keepPrice > c.maxPrice) blockWith("noQuote", "edge");
        else if (edge < minEdge - 1e-9) blockWith("edge", "edge");
        else {
          const kelly = edge / (1 - keepPrice);
          const stake = Math.min(c.kellyFraction * kelly * c.bankroll, c.maxStakePct * c.bankroll, c.maxMarketPct * c.bankroll - this.spent);
          if (stake < c.minStake) blockWith("stake", "edge");
          else {
            wants.bid[s] = { price: keepPrice, shares: Math.floor((stake / keepPrice) * 100) / 100 };
            ev[s].buyEdge = round(edge);
            ev[s].buy = entryOrder ? "quoting" : "ok";
          }
        }
      }
    }
    return { fair, signals, wants, decision: fastDecision(i, fair, ev.up, ev.down, signals, tau) };
  }

  private stopSignal(i: FastInput, side: PmSide, bid: number, pS: number, tau: number): PmSignal {
    const c = this.cfg;
    const pos = this.pos[side];
    const fee = takerFee(bid, c.feeRate, c.feeKind);
    const s: PmSignal = {
      id: `${this.market.slug}:e:${i.time}:${this.seq++}`,
      slug: this.market.slug,
      time: i.time,
      action: "sell",
      side,
      reason: "exit",
      price: bid,
      fee: round(fee, 5),
      shares: round(pos.shares, 3),
      amount: round(pos.shares * (bid - fee - c.slippage), 2),
      pSide: round(pS),
      edge: round(bid - fee - c.slippage - pS),
      tau: round(tau, 1),
      limit: round(Math.max(c.tick, floorTick(bid - 0.05, c.tick))),
    };
    this.stopPending[side] = s.id;
    return s;
  }

  /** Resultado de la salida de emergencia (taker). */
  onFill(signalId: string, fill: TakerFill | null): void {
    for (const s of ["up", "down"] as const) {
      if (this.stopPending[s] !== signalId) continue;
      this.stopPending[s] = null;
      if (fill && fill.shares > 0) this.reduce(s, fill.shares);
    }
  }

  private reduce(side: PmSide, shares: number): void {
    const pos = this.pos[side];
    const frac = pos.shares > 0 ? Math.min(1, shares / pos.shares) : 1;
    pos.cost *= 1 - frac;
    pos.shares = Math.max(0, pos.shares - shares);
    if (pos.shares < 1e-6) pos.shares = 0;
  }

  /** Ejecucion (parcial o total) de una orden en reposo: actualiza la posicion y devuelve la operacion (sin comision: maker). */
  onMakerFill(order: PmOrder, shares: number, time: number): PmSignal {
    const side = order.side;
    const pS = this.last ? this.last.pSide[side] : order.price;
    const tau = (this.market.end - time) / 1000;
    const amount = shares * order.price;
    if (order.action === "buy") {
      const pos = this.pos[side];
      if (pos.shares === 0) this.entries[side]++;
      pos.shares += shares;
      pos.cost += amount;
      this.spent += amount;
    } else this.reduce(side, shares);
    // una orden puede llenarse en varios niveles en el mismo ms (Predict manda el libro entero de golpe): id unico
    const key = `${order.id}:${time}`;
    const n = (this.fillIds.get(key) ?? 0) + 1;
    this.fillIds.set(key, n);
    return {
      id: n === 1 ? key : `${key}:${n}`,
      slug: this.market.slug,
      time,
      action: order.action,
      side,
      reason: order.action === "buy" ? "entry" : "exit",
      price: order.price,
      fee: 0,
      shares: round(shares, 3),
      amount: round(amount, 2),
      pSide: round(pS),
      edge: round(order.action === "buy" ? pS - order.price : order.price - pS),
      tau: round(tau, 1),
      signalPrice: order.price,
      execTime: time,
      maker: true,
    };
  }
}
