import { EventEmitter } from "node:events";
import { timingSafeEqual, createHash } from "node:crypto";
import { OrderBuilder, OrderType, orderToJsonV2, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { LiveTrade, LiveTradingState, PmMarket, PmSide, PmSignal } from "@updown/protocol";
import { ClobH2 } from "./clobConnection.js";
import { l2Headers, responseDetail, type ClobCreds } from "./latency.js";

/**
 * Compras/ventas REALES siguiendo al motor C (docs/features/live-trading.md). Solo actua si:
 *  - hay clave privada y contrasena configuradas (si no, `enabled` es false y nunca firma nada),
 *  - el interruptor esta activado para el market en curso (se apaga solo al cambiar de market),
 *  - la senal es del motor C y de ese mismo market.
 * Importe = paper x `scale` (1/5) entre `minUsd` y `maxUsd`, con tope `maxMarketUsd` por market. Orden FAK con precio
 * limite senal ± `slippage` (por defecto sin limite: 0.99 / 0.01; el importe en USDC sigue acotado). Firma local (OrderBuilder) y envio por la conexion
 * HTTP/2 caliente. La sonda de latencia sigue aparte y sigue firmada con ceros (latency.ts).
 */

export interface LiveTraderConfig {
  clobUrl: string;
  creds: ClobCreds;
  /** clave privada de la EOA firmante (PM_WALLET_PRIVATE_KEY); vacia = desactivado */
  privateKey: string;
  /** contrasena del interruptor (TRADING_PASSWORD); vacia = desactivado */
  password: string;
  /** real = paper x scale */
  scale: number;
  minUsd: number;
  maxUsd: number;
  /** tope de compras reales por market (USDC) */
  maxMarketUsd: number;
  /** tolerancia de precio frente a la senal (0.02 = 2c) */
  slippage: number;
  /** tick del market (BTC 5m: 0.01) */
  tick: number;
  /** minimo de tokens por orden en Polymarket (BTC 5m: 5): una compra menor no se podria vender */
  minShares: number;
  timeoutMs?: number;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Precio limite: compra = senal + tolerancia redondeado hacia arriba al tick (max 1 - tick); venta = senal - tolerancia hacia abajo (min tick). */
export function limitPriceFor(action: "buy" | "sell", signalPrice: number, slippage: number, tick: number): number {
  const steps = (action === "buy" ? signalPrice + slippage : signalPrice - slippage) / tick;
  const n = action === "buy" ? Math.ceil(round(steps, 6)) : Math.floor(round(steps, 6));
  return round(Math.min(1 - tick, Math.max(tick, n * tick)), 6);
}

/**
 * USDC reales de una compra: paper x scale, subido al minimo de Polymarket (>= minUsd y >= minShares tokens al precio de la
 * senal, para poder venderlos despues) y con tope maxUsd y lo que quede del tope por market. null si no cabe.
 * Se usa el precio de la senal y no el limite: sin limite (0.99) el minimo seria siempre ~5 USDC.
 */
export function realBuyUsd(paperUsd: number, signalPrice: number, c: Pick<LiveTraderConfig, "scale" | "minUsd" | "maxUsd" | "minShares">, remainingUsd: number): number | null {
  const min = Math.max(c.minUsd, c.minShares * signalPrice);
  const usd = Math.min(Math.max(paperUsd * c.scale, min), c.maxUsd, remainingUsd);
  return usd + 1e-9 < min ? null : round(usd, 2);
}

/** Importes de la respuesta del CLOB: decimales ("4.98") o enteros de 6 decimales ("4980000"). Para ordenes de <= 10 USDC un entero >= 100000 solo puede ser de 6 decimales. */
export function parseClobAmount(v: unknown): number {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return !s.includes(".") && n >= 100_000 ? n / 1e6 : n;
}

interface OrderResponse {
  success?: boolean;
  orderID?: string;
  status?: string;
  makingAmount?: string;
  takingAmount?: string;
  errorMsg?: string;
  error?: string;
}

/** Resultado de una respuesta del CLOB a una orden de `action`: cuanto se ejecuto y a que precio. */
export function evaluateFill(
  action: "buy" | "sell",
  signalPrice: number,
  httpStatus: number,
  body: OrderResponse | null,
): Pick<LiveTrade, "status" | "filledShares" | "filledUsd" | "avgPrice" | "slippage" | "orderId" | "detail"> {
  const detail = body?.errorMsg || body?.error || null;
  if (!body || httpStatus >= 300 || body.success === false) {
    return { status: "rejected", filledShares: 0, filledUsd: 0, avgPrice: null, slippage: null, orderId: body?.orderID || null, detail: detail ?? `HTTP ${httpStatus}` };
  }
  const making = parseClobAmount(body.makingAmount);
  const taking = parseClobAmount(body.takingAmount);
  // compra: das USDC (making) y recibes tokens (taking) · venta: das tokens (making) y recibes USDC (taking)
  const filledShares = round(action === "buy" ? taking : making, 6);
  const filledUsd = round(action === "buy" ? making : taking, 6);
  const avgPrice = filledShares > 0 ? round(filledUsd / filledShares, 6) : null;
  const slippage = avgPrice === null ? null : round(action === "buy" ? avgPrice - signalPrice : signalPrice - avgPrice, 6);
  const st = (body.status ?? "").toLowerCase();
  const status = filledShares > 0 ? "matched" : st === "delayed" ? "delayed" : "unmatched";
  return { status, filledShares, filledUsd, avgPrice, slippage, orderId: body.orderID || null, detail };
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const EMPTY_POS = (): Record<PmSide, { shares: number; costUsd: number }> => ({ up: { shares: 0, costUsd: 0 }, down: { shares: 0, costUsd: 0 } });

interface LiveTraderEvents {
  state: [LiveTradingState];
  trade: [LiveTrade];
}

export class LiveTrader extends EventEmitter<LiveTraderEvents> {
  readonly trades: LiveTrade[] = [];
  private armedSlug: string | null = null;
  private currentSlug: string | null = null;
  private position = EMPTY_POS();
  private spentUsd = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly builder: OrderBuilder | null = null;
  private readonly h2: ClobH2 | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  readonly disabledReason: string | null;

  constructor(
    private readonly c: LiveTraderConfig,
    /** reloj de Binance */
    private readonly now: () => number,
  ) {
    super();
    const k = c.privateKey.trim();
    const missing = [
      !k && "PM_WALLET_PRIVATE_KEY",
      !c.password && "TRADING_PASSWORD",
      !(c.creds.apiKey && c.creds.secret && c.creds.passphrase) && "credenciales CLOB",
      !c.creds.address && "PM_SIGNER_ADDRESS",
      !c.creds.funder && "PM_FUNDER_ADDRESS",
    ].filter(Boolean);
    this.disabledReason = missing.length ? `falta ${missing.join(", ")}` : null;
    if (this.disabledReason) return;
    const account = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`);
    if (account.address.toLowerCase() !== c.creds.address.toLowerCase()) {
      // la clave no es la del firmante de la API key: Polymarket rechazaria todo
      this.disabledReason = `la clave privada es de ${account.address}, no de PM_SIGNER_ADDRESS`;
      return;
    }
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    this.builder = new OrderBuilder(signer as never, 137, SignatureTypeV2.POLY_PROXY, c.creds.funder);
    this.h2 = new ClobH2(new URL(c.clobUrl).origin, c.timeoutMs ?? 5000);
  }

  get enabled(): boolean {
    return this.disabledReason === null;
  }

  start(): void {
    if (!this.h2) return;
    void this.h2.ensure().catch(() => {});
    this.keepAlive = setInterval(() => void this.h2!.ping().catch(() => {}), 5000);
  }

  stop(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.h2?.close();
  }

  state(): LiveTradingState {
    const { scale, minUsd, maxUsd, maxMarketUsd, slippage } = this.c;
    return {
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      armedSlug: this.armedSlug,
      currentSlug: this.currentSlug,
      limits: { scale, minUsd, maxUsd, maxMarketUsd, slippage },
      position: { up: { ...this.position.up }, down: { ...this.position.down } },
      spentUsd: round(this.spentUsd, 6),
    };
  }

  checkPassword(given: string | undefined): boolean {
    if (!this.c.password || !given) return false;
    return timingSafeEqual(sha(given), sha(this.c.password));
  }

  /** Activa/desactiva para el market en curso. Devuelve un error legible o null. */
  setArmed(slug: string, armed: boolean): string | null {
    if (!armed) {
      if (this.armedSlug) this.disarm("apagado por el usuario");
      return null;
    }
    if (!this.enabled) return `compras reales desactivadas: ${this.disabledReason}`;
    if (!this.currentSlug || slug !== this.currentSlug) return "solo se puede activar en el market en curso";
    if (this.armedSlug !== slug) {
      this.armedSlug = slug;
      this.position = EMPTY_POS();
      this.spentUsd = 0;
      this.trades.length = 0;
      console.log(`[live] ACTIVADO en ${slug}`);
      this.emit("state", this.state());
    }
    return null;
  }

  private disarm(why: string) {
    console.log(`[live] desactivado (${why}) en ${this.armedSlug}`);
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

  /** Senales del motor C en un paso. Se ejecutan en serie y en orden. */
  onSignals(signals: PmSignal[], market: PmMarket | null): void {
    if (!this.armedSlug || !market || market.slug !== this.armedSlug) return;
    for (const s of signals) {
      if (s.slug !== this.armedSlug) continue;
      this.queue = this.queue.then(() => this.execute(s, market)).catch((e) => console.error(`[live] ${e instanceof Error ? e.message : e}`));
    }
  }

  private record(t: LiveTrade) {
    this.trades.push(t);
    if (this.trades.length > 50) this.trades.shift();
    const parts = `${t.action} ${t.side} senal ${t.signalPrice} -> ${t.status}${t.avgPrice !== null ? ` a ${t.avgPrice}` : ""}${t.latencyMs !== null ? ` en ${t.latencyMs} ms` : ""}${t.detail ? ` (${t.detail})` : ""}`;
    console.log(`[live] ${parts}`);
    this.emit("trade", t);
    this.emit("state", this.state());
  }

  private async execute(s: PmSignal, market: PmMarket): Promise<void> {
    if (!this.builder || !this.h2 || this.armedSlug !== s.slug) return;
    const token = s.side === "up" ? market.upToken : market.downToken;
    const limitPrice = limitPriceFor(s.action, s.price, this.c.slippage, this.c.tick);
    const base: LiveTrade = {
      signalId: s.id,
      slug: s.slug,
      action: s.action,
      side: s.side,
      reason: s.reason,
      signalTime: s.time,
      signalPrice: s.price,
      paperAmount: s.amount,
      requestedUsd: null,
      requestedShares: null,
      limitPrice,
      sentAt: null,
      respondedAt: null,
      latencyMs: null,
      signMs: null,
      status: "skipped",
      filledShares: 0,
      filledUsd: 0,
      avgPrice: null,
      slippage: null,
      orderId: null,
      detail: null,
    };
    if (!token) return this.record({ ...base, detail: "sin token del market" });

    let amount: number;
    if (s.action === "buy") {
      const usd = realBuyUsd(s.amount, s.price, this.c, this.c.maxMarketUsd - this.spentUsd);
      if (usd === null) return this.record({ ...base, detail: `fuera de limites (gastado ${round(this.spentUsd, 2)} de ${this.c.maxMarketUsd} USDC en el market)` });
      base.requestedUsd = usd;
      amount = usd;
    } else {
      const held = Math.floor(this.position[s.side].shares * 100) / 100;
      if (held <= 0) return this.record({ ...base, detail: "sin tokens reales de ese lado que vender" });
      base.requestedShares = held;
      amount = held;
    }

    try {
      const t0 = performance.now();
      const signed = await this.builder.buildMarketOrder(
        { tokenID: token, price: limitPrice, amount, side: s.action === "buy" ? Side.BUY : Side.SELL, orderType: OrderType.FAK },
        { tickSize: String(this.c.tick) as never, negRisk: false },
        2,
      );
      const body = JSON.stringify(orderToJsonV2(signed as never, this.c.creds.apiKey, OrderType.FAK));
      const headers = { ...l2Headers(this.c.creds, "POST", "/order", body), "content-type": "application/json" };
      base.signMs = round(performance.now() - t0, 2);
      base.sentAt = this.now();
      const r = await this.h2.request("POST", "/order", headers, body);
      base.respondedAt = this.now();
      base.latencyMs = round(r.ms, 1);
      let parsed: OrderResponse | null = null;
      try {
        parsed = JSON.parse(r.text) as OrderResponse;
      } catch {
        parsed = null;
      }
      const fill = evaluateFill(s.action, s.price, r.status, parsed);
      if (fill.detail === null && !parsed) fill.detail = responseDetail(r.text) ?? null;
      const trade: LiveTrade = { ...base, ...fill };
      if (trade.filledShares > 0) {
        const pos = this.position[s.side];
        if (s.action === "buy") {
          pos.shares = round(pos.shares + trade.filledShares, 6);
          pos.costUsd = round(pos.costUsd + trade.filledUsd, 6);
          this.spentUsd += trade.filledUsd;
        } else {
          const frac = pos.shares > 0 ? Math.min(1, trade.filledShares / pos.shares) : 1;
          pos.costUsd = round(pos.costUsd * (1 - frac), 6);
          pos.shares = round(Math.max(0, pos.shares - trade.filledShares), 6);
        }
      }
      this.record(trade);
    } catch (e) {
      this.record({ ...base, status: "error", respondedAt: base.sentAt ? this.now() : null, detail: e instanceof Error ? e.message : String(e) });
    }
  }
}
