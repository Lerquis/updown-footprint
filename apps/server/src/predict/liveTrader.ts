import { EventEmitter } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
import { Side } from "@predictdotfun/sdk";
import type { LiveEngine, LiveSizing, LiveTrade, LiveTradingState, PmMarket, PmSide, PmSignal } from "@updown/protocol";
import type { TokenBook } from "../polymarket/pmBook.js";
import { predictError, type PredictAccount } from "./account.js";
import { parseToken, type PredictTradingInfo } from "./model.js";

/**
 * Compras/ventas REALES en Predict.fun siguiendo al motor elegido (A, C o D) de UNA fuente, igual que `LiveTrader` en Polymarket
 * (interruptor por market con `TRADING_PASSWORD`, topes por orden y por market, importe proporcional o minimo). Diferencias:
 *  - Orden MARKET del SDK (`getMarketOrderAmounts` sobre el libro del lado que se opera; el de Down es el espejo del de Up):
 *    compra por importe (`valueWei`, `isMinAmountOut`), venta por cantidad. Nunca queda en el libro.
 *  - **Minimo de Predict**: una compra vale al menos 1 USDT (`create_order_min_order_value_not_met`); el importe nunca baja de ahi.
 *    Una venta de mercado admite desde 0,01 shares.
 *  - El 201 de `POST /v1/orders` solo dice "aceptada" (`pending`): lo ejecutado llega despues por los eventos de la wallet
 *    (`orderTransactionSuccess` con tamano, importe y comision; `matchedAt` = su `timestamp`, reloj de Predict).
 * Ver docs/features/predict-markets.md#compras-reales.
 */

export interface PredictLiveConfig {
  /** contrasena del interruptor (TRADING_PASSWORD); vacia = desactivado */
  password: string;
  /** real = paper x scale */
  scale: number;
  /** minimo por compra (USDT); nunca menos que el de Predict (1 USDT) */
  minUsd: number;
  maxUsd: number;
  /** tope de compras por market (USDT) */
  maxMarketUsd: number;
  /** deslizamiento aceptado en A y C (puntos basicos sobre el peor nivel del libro que se consume); D usa su limite */
  slippageBps: number;
}

/** Minimo de Predict para una compra (USDT) */
export const PREDICT_MIN_BUY_USD = 1;
/** Minimo de Predict para una venta de mercado (shares) */
export const PREDICT_MIN_SELL_SHARES = 0.01;

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const WEI = 10n ** 18n;
/** USDT con 2 decimales -> wei */
export const usdToWei = (usd: number) => BigInt(Math.round(usd * 100)) * 10n ** 16n;
/** shares (truncadas a 0,001) -> wei */
export const sharesToWei = (shares: number) => BigInt(Math.floor(round(shares * 1000, 6))) * 10n ** 15n;
const fromWei = (v: unknown) => {
  try {
    return Number(BigInt(String(v)) * 1_000_000n / WEI) / 1e6;
  } catch {
    return 0;
  }
};

/**
 * USDT de una compra: paper x scale, subido al minimo (max(minUsd, 1 USDT de Predict)), con tope maxUsd y lo que quede del tope
 * por market. null si lo que queda no llega al minimo: nunca se envia una compra por debajo del minimo de Predict.
 */
export function predictBuyUsd(paperUsd: number, c: Pick<PredictLiveConfig, "scale" | "minUsd" | "maxUsd">, remainingUsd: number): number | null {
  const min = Math.max(PREDICT_MIN_BUY_USD, c.minUsd);
  const usd = Math.min(Math.max(paperUsd * c.scale, min), c.maxUsd, remainingUsd);
  return usd + 1e-9 < min ? null : Math.floor(usd * 100) / 100;
}

/**
 * Importes de una compra que cumplen el minimo de Predict. El SDK redondea hacia abajo (1 USDT de presupuesto firma 0,999972),
 * asi que si lo firmado queda por debajo del minimo se sube el presupuesto de centavo en centavo (como mucho `maxSteps`).
 * Devuelve los importes y el presupuesto usado, o null si no se llega.
 */
export function buyAmountsAtLeast<A extends { makerAmount: bigint }>(amountsFor: (valueWei: bigint) => A, usd: number, minUsd: number, maxSteps = 5): { amounts: A; usd: number } | null {
  const min = usdToWei(Math.max(PREDICT_MIN_BUY_USD, minUsd));
  for (let i = 0; i <= maxSteps; i++) {
    const v = Math.round((usd + i * 0.01) * 100) / 100;
    const amounts = amountsFor(usdToWei(v));
    if (amounts.makerAmount >= min) return { amounts, usd: v };
  }
  return null;
}

/**
 * Deslizamiento (bps) para que el peor precio firmado no pase del limite del motor D. Con `isMinAmountOut` el SDK firma
 * peor nivel / (1 - deslizamiento): bps = (1 - peor nivel / limite) x 10000. 0 si el limite ya es el peor nivel o menos.
 */
export function slippageForLimit(limit: number, worstPrice: number): number {
  if (limit <= 0 || worstPrice <= 0 || limit <= worstPrice) return 0;
  return Math.max(0, Math.min(9999, Math.floor((1 - worstPrice / limit) * 10000)));
}

/** Ejecucion de un evento `orderTransactionSuccess`: tokens netos (la comision de una compra se cobra en tokens), USDT y comision */
export function walletFill(action: "buy" | "sell", ev: Record<string, unknown>): { shares: number; usd: number } | null {
  const fill = ev.fill as { executedSizeWei?: unknown; executedValueWei?: unknown } | undefined;
  if (!fill) return null;
  const size = fromWei(fill.executedSizeWei);
  const value = fromWei(fill.executedValueWei);
  if (size <= 0) return null;
  const fee = ev.fee as { amountWei?: unknown; type?: unknown } | undefined;
  const feeAmt = fee ? fromWei(fee.amountWei) : 0;
  if (action === "buy") return { shares: round(size - (fee?.type === "SHARES" ? feeAmt : 0), 6), usd: round(value, 6) };
  return { shares: round(size, 6), usd: round(value - (fee?.type === "COLLATERAL" ? feeAmt : 0), 6) };
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const EMPTY_POS = (): Record<PmSide, { shares: number; costUsd: number }> => ({ up: { shares: 0, costUsd: 0 }, down: { shares: 0, costUsd: 0 } });

interface Events {
  state: [LiveTradingState];
  trade: [LiveTrade];
}

/** Lo que guarda el trader de cada orden enviada (ademas de la operacion publica) */
interface Sent {
  trade: LiveTrade;
  hash: string | null;
  /** USDT reservados del tope por market hasta saber lo ejecutado */
  reservedUsd: number;
  /** importe bruto ejecutado (para el precio medio) */
  grossShares: number;
  grossUsd: number;
  final: boolean;
}

export class PredictLiveTrader extends EventEmitter<Events> {
  readonly trades: LiveTrade[] = [];
  private sent = new Map<string, Sent>();
  private armedSlug: string | null = null;
  private engine: LiveEngine = "c";
  private sizing: LiveSizing = "scaled";
  private currentSlug: string | null = null;
  private position = EMPTY_POS();
  private spentUsd = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly c: PredictLiveConfig,
    private readonly account: PredictAccount,
    /** datos para firmar del market (tokens on-chain, comision, exchange) */
    private readonly info: (marketId: number) => PredictTradingInfo | null,
    /** libro de un token sintetico `<marketId>:up|down` (el que mantienen los motores) */
    private readonly book: (token: string) => TokenBook | null,
    /** reloj de Binance */
    private readonly now: () => number,
    private readonly tag: string,
  ) {
    super();
    account.on("wallet", (ev) => this.onWallet(ev));
    account.on("state", () => this.emit("state", this.state()));
  }

  get disabledReason(): string | null {
    if (!this.c.password) return "falta TRADING_PASSWORD";
    if (this.account.disabledReason) return this.account.disabledReason;
    if (!this.account.builder) return "preparando la firma…";
    if (this.account.approvals && !this.account.approvals.ok) return `faltan aprobaciones (${this.account.approvals.missing.join(", ")}): npm run predict:approvals`;
    return null;
  }

  get enabled(): boolean {
    return this.disabledReason === null;
  }

  state(): LiveTradingState {
    const { scale, minUsd, maxUsd, maxMarketUsd, slippageBps } = this.c;
    return {
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      armedSlug: this.armedSlug,
      engine: this.engine,
      sizing: this.sizing,
      userStream: this.account.walletStream,
      currentSlug: this.currentSlug,
      limits: { scale, minUsd: Math.max(PREDICT_MIN_BUY_USD, minUsd), maxUsd, maxMarketUsd, slippage: slippageBps / 10000 },
      position: { up: { ...this.position.up }, down: { ...this.position.down } },
      spentUsd: round(this.spentUsd, 6),
      balanceUsd: this.account.balanceUsd,
    };
  }

  checkPassword(given: string | undefined): boolean {
    if (!this.c.password || !given) return false;
    return timingSafeEqual(sha(given), sha(this.c.password));
  }

  /** Activa/desactiva en el market en curso. Al activar inicia sesion (JWT) si hace falta. Devuelve un error legible o null. */
  async setArmed(slug: string, armed: boolean, opts: { engine?: LiveEngine; sizing?: LiveSizing } = {}): Promise<string | null> {
    if (opts.engine === "a" || opts.engine === "c" || opts.engine === "d") this.engine = opts.engine;
    if (opts.sizing === "scaled" || opts.sizing === "min") this.sizing = opts.sizing;
    if (!armed) {
      if (this.armedSlug) this.disarm("apagado por el usuario");
      else this.emit("state", this.state());
      return null;
    }
    if (!this.enabled) return `compras reales desactivadas: ${this.disabledReason}`;
    if (!this.currentSlug || slug !== this.currentSlug) return "solo se puede activar en el market en curso";
    try {
      await this.account.ensureLogin();
    } catch (e) {
      return `no se pudo iniciar sesion en Predict: ${e instanceof Error ? e.message : e}`;
    }
    if (this.armedSlug !== slug) {
      this.armedSlug = slug;
      this.position = EMPTY_POS();
      this.spentUsd = 0;
      this.trades.length = 0;
      console.log(`[${this.tag}] ACTIVADO en ${slug} (motor ${this.engine.toUpperCase()}, importe ${this.sizing})`);
    }
    this.emit("state", this.state());
    return null;
  }

  private disarm(why: string) {
    console.log(`[${this.tag}] desactivado (${why}) en ${this.armedSlug}`);
    this.armedSlug = null;
    this.emit("state", this.state());
  }

  /** Cambio de market en curso: si estaba activado en otro, se apaga (funciona solo por market). */
  onMarket(current: PmMarket | null): void {
    const slug = current?.slug ?? null;
    if (slug === this.currentSlug) return;
    this.currentSlug = slug;
    if (this.armedSlug && this.armedSlug !== slug) this.disarm("termino el market");
    else this.emit("state", this.state());
  }

  /** Senales de un motor: solo cuentan las del motor elegido y del market activado. En serie y en orden. */
  onSignals(engine: LiveEngine, signals: PmSignal[], market: PmMarket | null): void {
    if (engine !== this.engine || !this.armedSlug || !market || market.slug !== this.armedSlug) return;
    for (const s of signals) {
      if (s.slug !== this.armedSlug) continue;
      this.queue = this.queue.then(() => this.execute(s, market, engine)).catch((e) => console.error(`[${this.tag}] ${e instanceof Error ? e.message : e}`));
    }
  }

  private publish(t: LiveTrade, log = true) {
    const i = this.trades.findIndex((x) => x.signalId === t.signalId);
    if (i >= 0) this.trades[i] = t;
    else {
      this.trades.push(t);
      if (this.trades.length > 50) this.trades.shift();
    }
    if (log) {
      const parts = `${t.action} ${t.side} senal ${t.signalPrice} -> ${t.status}${t.avgPrice !== null ? ` a ${t.avgPrice}` : ""}${t.latencyMs !== null ? ` en ${t.latencyMs} ms` : ""}${t.detail ? ` (${t.detail})` : ""}`;
      console.log(`[${this.tag}] ${parts}`);
    }
    this.emit("trade", { ...t });
    this.emit("state", this.state());
  }

  private async execute(s: PmSignal, market: PmMarket, engine: LiveEngine): Promise<void> {
    const b = this.account.builder;
    if (!b || this.armedSlug !== s.slug) return;
    const base: LiveTrade = {
      signalId: s.id,
      engine,
      slug: s.slug,
      action: s.action,
      side: s.side,
      reason: s.reason,
      signalTime: s.time,
      signalPrice: s.price,
      paperAmount: s.amount,
      requestedUsd: null,
      requestedShares: null,
      limitPrice: s.limit ?? (s.action === "buy" ? 0.99 : 0.01),
      sentAt: null,
      respondedAt: null,
      latencyMs: null,
      matchedAt: null,
      signMs: null,
      status: "skipped",
      filledShares: 0,
      filledUsd: 0,
      avgPrice: null,
      slippage: null,
      orderId: null,
      detail: null,
    };
    const token = s.side === "up" ? market.upToken : market.downToken;
    const id = parseToken(token);
    const info = id ? this.info(id.marketId) : null;
    if (!id || !info) return this.publish({ ...base, detail: "sin datos del market para firmar" });
    const book = this.book(token);
    if (!book || book.time === 0) return this.publish({ ...base, detail: "sin libro del market" });

    let reservedUsd = 0;
    try {
      const t0 = performance.now();
      const sdkBook = { marketId: id.marketId, updateTimestampMs: book.time, asks: book.levels("ask"), bids: book.levels("bid") };
      let amounts: ReturnType<typeof b.getMarketOrderAmounts>;
      if (s.action === "buy") {
        const usd = predictBuyUsd(this.sizing === "min" ? 0 : s.amount, this.c, this.c.maxMarketUsd - this.spentUsd);
        if (usd === null) return this.publish({ ...base, detail: `fuera de limites (gastado ${round(this.spentUsd, 2)} de ${this.c.maxMarketUsd} USDT en el market; minimo ${Math.max(PREDICT_MIN_BUY_USD, this.c.minUsd)} USDT)` });
        base.requestedUsd = usd;
        const valueWei = usdToWei(usd);
        // D: el peor precio firmado no pasa de su limite; A y C: deslizamiento configurado
        let slippageBps = BigInt(this.c.slippageBps);
        if (s.limit !== undefined) {
          const probe = b.getMarketOrderAmounts({ side: Side.BUY, valueWei, slippageBps: 0n, isMinAmountOut: true }, sdkBook);
          const worst = Number(probe.lastPrice) / 1e18;
          if (worst > s.limit) return this.publish({ ...base, detail: `el libro (${worst}) supera el limite del motor (${s.limit})` });
          slippageBps = BigInt(slippageForLimit(s.limit, worst));
        }
        // nunca por debajo del minimo de Predict: el SDK redondea hacia abajo
        const ok = buyAmountsAtLeast((v) => b.getMarketOrderAmounts({ side: Side.BUY, valueWei: v, slippageBps, isMinAmountOut: true }, sdkBook), usd, this.c.minUsd);
        if (!ok) return this.publish({ ...base, detail: `no se llega al minimo de ${Math.max(PREDICT_MIN_BUY_USD, this.c.minUsd)} USDT con el libro actual` });
        amounts = ok.amounts;
        base.requestedUsd = ok.usd;
      } else {
        const held = Math.floor(this.position[s.side].shares * 1000) / 1000;
        if (held < PREDICT_MIN_SELL_SHARES) return this.publish({ ...base, detail: "sin tokens reales de ese lado que vender (o por debajo del minimo de 0,01)" });
        base.requestedShares = held;
        amounts = b.getMarketOrderAmounts({ side: Side.SELL, quantityWei: sharesToWei(held), slippageBps: BigInt(this.c.slippageBps) }, sdkBook);
      }
      const order = b.buildOrder("MARKET", {
        side: s.action === "buy" ? Side.BUY : Side.SELL,
        tokenId: s.side === "up" ? info.upTokenId : info.downTokenId,
        makerAmount: amounts.makerAmount,
        takerAmount: amounts.takerAmount,
        feeRateBps: info.feeRateBps,
      });
      const typed = b.buildTypedData(order, { isNegRisk: info.isNegRisk, isYieldBearing: info.isYieldBearing });
      const signed = await b.signTypedDataOrder(typed);
      const hash = b.buildTypedDataHash(typed);
      const body = JSON.stringify({
        data: {
          order: { ...signed, hash },
          pricePerShare: amounts.pricePerShare.toString(),
          strategy: "MARKET",
          slippageBps: amounts.slippageBps.toString(),
          ...(amounts.isMinAmountOut !== undefined ? { isMinAmountOut: amounts.isMinAmountOut } : {}),
        },
      });
      base.signMs = round(performance.now() - t0, 2);
      await this.account.ensureLogin();
      if (s.action === "buy") {
        reservedUsd = base.requestedUsd ?? 0;
        this.spentUsd += reservedUsd;
      }
      base.sentAt = this.now();
      const r = await this.account.request("POST", "/v1/orders", body, true);
      base.respondedAt = this.now();
      base.latencyMs = round(r.ms, 1);
      if (r.status !== 201 && r.status !== 200) {
        this.spentUsd -= reservedUsd;
        return this.publish({ ...base, status: "rejected", detail: predictError(r.text) ?? `HTTP ${r.status}` });
      }
      const data = (JSON.parse(r.text) as { data?: { orderId?: string; orderHash?: string } }).data ?? {};
      const trade: LiveTrade = { ...base, status: "pending", orderId: data.orderId ?? null, detail: "aceptada, esperando la ejecucion" };
      const sent: Sent = { trade, hash: data.orderHash ?? hash, reservedUsd, grossShares: 0, grossUsd: 0, final: false };
      this.sent.set(trade.orderId ?? sent.hash!, sent);
      if (sent.hash) this.sent.set(sent.hash, sent);
      this.publish(trade);
    } catch (e) {
      this.spentUsd -= reservedUsd;
      this.publish({ ...base, status: "error", respondedAt: base.sentAt ? this.now() : null, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Evento de una orden de la wallet: ejecuciones (tamano real, comision, hora de Predict) y finales sin ejecucion */
  private onWallet(ev: Record<string, unknown>) {
    const key = [ev.orderId, ev.orderHash].map((x) => (typeof x === "string" ? x : "")).find((k) => k && this.sent.has(k));
    if (!key) return; // orden de otra fuente o de fuera del sistema
    const sent = this.sent.get(key)!;
    const t = sent.trade;
    const at = typeof ev.timestamp === "number" ? ev.timestamp : null;
    switch (ev.type) {
      case "orderTransactionSuccess": {
        const f = walletFill(t.action, ev);
        if (!f) return;
        const fill = ev.fill as { executedSizeWei?: unknown; executedValueWei?: unknown };
        sent.grossShares += fromWei(fill.executedSizeWei);
        sent.grossUsd += fromWei(fill.executedValueWei);
        t.filledShares = round(t.filledShares + f.shares, 6);
        t.filledUsd = round(t.filledUsd + f.usd, 6);
        t.avgPrice = sent.grossShares > 0 ? round(sent.grossUsd / sent.grossShares, 6) : null;
        t.slippage = t.avgPrice === null ? null : round(t.action === "buy" ? t.avgPrice - t.signalPrice : t.signalPrice - t.avgPrice, 6);
        if (at !== null && (t.matchedAt === null || at < t.matchedAt)) t.matchedAt = at;
        t.status = "matched";
        t.detail = null;
        const pos = this.position[t.side];
        if (t.action === "buy") {
          pos.shares = round(pos.shares + f.shares, 6);
          pos.costUsd = round(pos.costUsd + f.usd, 6);
        } else {
          const frac = pos.shares > 0 ? Math.min(1, f.shares / pos.shares) : 1;
          pos.costUsd = round(pos.costUsd * (1 - frac), 6);
          pos.shares = round(Math.max(0, pos.shares - f.shares), 6);
        }
        // la reserva de una compra pasa a ser lo ejecutado
        if (t.action === "buy") {
          this.spentUsd += f.usd - Math.min(sent.reservedUsd, f.usd);
          sent.reservedUsd = Math.max(0, sent.reservedUsd - f.usd);
        }
        break;
      }
      case "orderTransactionFailed":
        t.detail = "la liquidacion on-chain fallo";
        break;
      case "orderNotAccepted":
      case "orderCancelled":
      case "orderExpired": {
        sent.final = true;
        // lo no ejecutado de una compra vuelve al tope por market
        if (t.action === "buy" && sent.reservedUsd > 0) {
          this.spentUsd -= sent.reservedUsd;
          sent.reservedUsd = 0;
        }
        if (t.filledShares === 0) {
          t.status = "unmatched";
          t.detail = `${String(ev.type)}${typeof ev.reason === "string" ? `: ${ev.reason}` : ""}`;
        }
        break;
      }
      case "orderMarketMatchPlan":
        // una orden de mercado se da por cerrada cuando se sabe lo que no se va a ejecutar
        if (t.action === "buy" && typeof ev.remainderCancelled === "string" && ev.remainderCancelled !== "0") t.detail = "parte sin liquidez cancelada";
        break;
      default:
        return;
    }
    this.publish({ ...t }, ev.type !== "orderMarketMatchPlan");
  }
}
