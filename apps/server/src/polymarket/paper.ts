import type { PmCancelReason, PmOrder, PmSide, PmSignal } from "@updown/protocol";
import { takerFee } from "./model.js";
import { walkBook, type PmTrade, type TokenBook } from "./pmBook.js";

/**
 * Papel realista de los motores D y E (docs/features/predictive-engines.md). El papel de A y C supone ejecutar al precio del
 * segundo de la senal; en la realidad una orden tarda 1-5 s y el precio ya se movio. Aqui:
 *  - `PaperTaker` (D y salidas de emergencia de E): la orden se ejecuta `latencyMs` despues contra el libro REAL de ese
 *    instante, nivel a nivel y sin pasar del precio limite. Si el precio se fue, no se ejecuta (o solo en parte).
 *  - `PaperMaker` (E): una orden en reposo entra al libro tras `postLatencyMs` al final de la cola de su precio; solo se ejecuta
 *    cuando los trades de Polymarket consumen la cola por delante o atraviesan su precio. Cancelar tarda `cancelLatencyMs`
 *    (mientras tanto se puede ejecutar).
 */

const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

/** Ejecucion de una orden taker simulada */
export interface PaperTakerFill {
  signal: PmSignal;
  /** operacion ejecutada (precio medio real, tokens y USDC) o null si no se ejecuto */
  filled: PmSignal | null;
  shares: number;
  usd: number;
}

export class PaperTaker {
  private pending: { signal: PmSignal; token: string; due: number }[] = [];

  constructor(
    private readonly latencyMs: number,
    private readonly feeRate: number,
  ) {}

  submit(signal: PmSignal, token: string, now: number): void {
    this.pending.push({ signal, token, due: now + this.latencyMs });
  }

  get size(): number {
    return this.pending.length;
  }

  /** Ejecuta las ordenes vencidas con el libro de ahora. `end`: tras el cierre del market ya no se ejecuta nada. */
  resolve(now: number, book: (token: string) => TokenBook | null, end: number): PaperTakerFill[] {
    const out: PaperTakerFill[] = [];
    const keep: typeof this.pending = [];
    for (const p of this.pending) {
      if (p.due > now) {
        keep.push(p);
        continue;
      }
      out.push(this.execute(p.signal, now < end ? book(p.token) : null, now));
    }
    this.pending = keep;
    return out;
  }

  /** Lo pendiente se descarta (cambio de market): se devuelve como no ejecutado. */
  drop(): PaperTakerFill[] {
    const out = this.pending.map((p) => ({ signal: p.signal, filled: null, shares: 0, usd: 0 }));
    this.pending = [];
    return out;
  }

  private execute(s: PmSignal, book: TokenBook | null, now: number): PaperTakerFill {
    const miss = { signal: s, filled: null, shares: 0, usd: 0 };
    if (!book) return miss;
    const limit = s.limit ?? (s.action === "buy" ? 0.99 : 0.01);
    if (s.action === "buy") {
      // presupuesto nocional: el importe con comision incluida
      const ask = book.bestAsk();
      if (ask === null) return miss;
      const budget = s.amount / (1 + this.feeRate * (1 - ask));
      const w = walkBook(book.levels("ask"), "buy", budget, limit);
      if (w.shares <= 1e-9 || w.avg === null) return miss;
      const fee = takerFee(w.avg, this.feeRate) * w.shares;
      const usd = w.usd + fee;
      return { signal: s, shares: w.shares, usd, filled: { ...s, price: round(w.avg, 4), signalPrice: s.price, execTime: now, fee: round(takerFee(w.avg, this.feeRate), 5), shares: round(w.shares, 3), amount: round(usd, 2) } };
    }
    const w = walkBook(book.levels("bid"), "sell", s.shares, limit);
    if (w.shares <= 1e-9 || w.avg === null) return miss;
    const fee = takerFee(w.avg, this.feeRate) * w.shares;
    const usd = w.usd - fee;
    return { signal: s, shares: w.shares, usd, filled: { ...s, price: round(w.avg, 4), signalPrice: s.price, execTime: now, fee: round(takerFee(w.avg, this.feeRate), 5), shares: round(w.shares, 3), amount: round(usd, 2) } };
  }
}

/** Orden en reposo simulada: la publica (`PmOrder`) mas el token */
interface SimOrder {
  o: PmOrder;
  token: string;
}

/** Ejecucion (parcial o total) de una orden en reposo */
export interface MakerFill {
  order: PmOrder;
  shares: number;
  time: number;
}

export interface PaperMakerOptions {
  postLatencyMs: number;
  cancelLatencyMs: number;
}

const bookSide = (o: PmOrder): "bid" | "ask" => (o.action === "buy" ? "bid" : "ask");

export class PaperMaker {
  private readonly orders = new Map<string, SimOrder>();
  private seq = 0;
  /** ordenes que cambiaron desde el ultimo `takeChanged` (para emitirlas) */
  private changed = new Set<string>();

  constructor(
    private readonly slug: string,
    private readonly opts: PaperMakerOptions,
  ) {}

  /** Ordenes aun vivas (pendientes de entrar o en el libro) */
  open(): PmOrder[] {
    return [...this.orders.values()].filter((x) => x.o.status === "pending" || x.o.status === "open").map((x) => x.o);
  }

  all(): PmOrder[] {
    return [...this.orders.values()].map((x) => x.o);
  }

  takeChanged(): PmOrder[] {
    const out = [...this.changed].map((id) => ({ ...this.orders.get(id)!.o }));
    this.changed.clear();
    return out;
  }

  private touch(o: PmOrder) {
    this.changed.add(o.id);
  }

  place(side: PmSide, action: "buy" | "sell", price: number, shares: number, token: string, now: number): PmOrder {
    const o: PmOrder = {
      id: `${this.slug}:e:o${this.seq++}`,
      slug: this.slug,
      side,
      action,
      price,
      shares,
      placedAt: now,
      liveAt: now + this.opts.postLatencyMs,
      cancelAt: null,
      queueAhead: 0,
      filledShares: 0,
      filledAt: null,
      status: "pending",
      cancelReason: null,
    };
    this.orders.set(o.id, { o, token });
    this.touch(o);
    return o;
  }

  cancel(id: string, now: number, reason: PmCancelReason): void {
    const x = this.orders.get(id);
    if (!x || x.o.cancelAt !== null || (x.o.status !== "pending" && x.o.status !== "open")) return;
    x.o.cancelAt = now + this.opts.cancelLatencyMs;
    x.o.cancelReason = reason;
    this.touch(x.o);
  }

  /** Cancela todo lo vivo al instante (fin del market). */
  cancelAll(now: number, reason: PmCancelReason): void {
    for (const { o } of this.orders.values()) {
      if (o.status !== "pending" && o.status !== "open") continue;
      o.status = "cancelled";
      o.cancelAt ??= now;
      o.cancelReason ??= reason;
      this.touch(o);
    }
  }

  /**
   * Avanza el reloj: las pendientes entran al libro (al final de la cola de su precio; si cruzarian el libro, post-only las
   * rechaza) y las cancelaciones vencidas se aplican.
   */
  advance(now: number, book: (token: string) => TokenBook | null): void {
    for (const x of this.orders.values()) {
      const o = x.o;
      if (o.status === "pending" && o.liveAt <= now) {
        if (o.cancelAt !== null && o.cancelAt <= o.liveAt) {
          o.status = "cancelled";
          this.touch(o);
          continue;
        }
        const b = book(x.token);
        const cross = b ? (o.action === "buy" ? b.bestAsk() : b.bestBid()) : null;
        if (cross !== null && (o.action === "buy" ? cross <= o.price + 1e-9 : cross >= o.price - 1e-9)) {
          // post-only: cruzaria el libro -> rechazada (se recolocara en el siguiente paso)
          o.status = "cancelled";
          o.cancelAt = now;
          o.cancelReason = "reprice";
        } else {
          o.status = "open";
          o.queueAhead = b ? b.sizeAt(bookSide(o), o.price) : 0;
        }
        this.touch(o);
      }
      if (o.status === "open" && o.cancelAt !== null && o.cancelAt <= now) {
        o.status = "cancelled";
        this.touch(o);
      }
    }
  }

  /** Trade de Polymarket: consume la cola por delante en nuestro precio o atraviesa nuestro precio (nos ejecuta). */
  onTrade(t: PmTrade, now: number): MakerFill[] {
    const fills: MakerFill[] = [];
    for (const x of this.orders.values()) {
      const o = x.o;
      if (o.status !== "open" || x.token !== t.token) continue;
      const left = o.shares - o.filledShares;
      if (left <= 1e-9) continue;
      const through = o.action === "buy" ? t.price < o.price - 1e-9 : t.price > o.price + 1e-9;
      const atPrice = Math.abs(t.price - o.price) < 1e-9 && (o.action === "buy" ? t.side === "sell" : t.side === "buy");
      let take = 0;
      if (through) take = Math.min(left, t.size);
      else if (atPrice) {
        o.queueAhead -= t.size;
        if (o.queueAhead < 0) {
          take = Math.min(left, -o.queueAhead);
          o.queueAhead = 0;
        }
        this.touch(o);
      }
      if (take > 0) fills.push(this.fill(o, take, now));
    }
    return fills;
  }

  /**
   * Cambio de nivel del libro: si el nivel de nuestro precio encoge sin trades, los que se fueron estaban por delante como mucho
   * hasta el nuevo tamano (cola = min(cola, tamano)). Un nivel contrario que cruza nuestro precio significa que alguien vendio
   * (o compro) a nuestro precio o mejor: nos habria ejecutado.
   */
  onLevel(tokenId: string, side: "bid" | "ask", price: number, size: number, now: number): MakerFill[] {
    const fills: MakerFill[] = [];
    for (const x of this.orders.values()) {
      const o = x.o;
      if (o.status !== "open" || x.token !== tokenId) continue;
      if (side === bookSide(o) && Math.abs(price - o.price) < 1e-9 && size < o.queueAhead) {
        o.queueAhead = size;
        this.touch(o);
      }
      const crosses = side !== bookSide(o) && size > 0 && (o.action === "buy" ? price < o.price - 1e-9 : price > o.price + 1e-9);
      if (crosses) {
        const left = o.shares - o.filledShares;
        if (left > 1e-9) fills.push(this.fill(o, Math.min(left, size), now));
      }
    }
    return fills;
  }

  private fill(o: PmOrder, shares: number, now: number): MakerFill {
    o.filledShares = round(o.filledShares + shares, 4);
    o.filledAt ??= now;
    if (o.shares - o.filledShares <= 1e-6) o.status = "filled";
    this.touch(o);
    return { order: { ...o }, shares, time: now };
  }
}
