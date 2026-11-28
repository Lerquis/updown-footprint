import { EventEmitter } from "node:events";
import type { LiveEngine, MakerProbeSample, MakerProbeState, PmMarket, PmSide, PmSignal } from "@updown/protocol";
import type { ClobCall } from "./liveTrader.js";

/**
 * Check maker (docs/features/latency.md): ordenes MAKER reales siguiendo las senales del motor elegido (A o C), para medir
 * el ciclo de una orden limite y si se ejecuta.
 *  - Compra del motor -> compra post-only a mejor bid + 1 tick (si el spread es de 1 tick, se une al mejor bid) de
 *    max(1 USDC, 5 tokens); se cancela a los `restMs` (2 s) si no se lleno entera.
 *  - Venta del motor -> lo mismo en el lado ask con los tokens comprados asi (si hay al menos 5).
 * Mide: firma, POST /order, confirmacion (canal de usuario), aparicion en el libro publico, primera ejecucion, DELETE /order y
 * desaparicion. Apagado por defecto; se activa con la contrasena de trading; solo el market en curso; tope por market; se apaga
 * solo tras `max` ordenes.
 */

export interface MakerProbeOptions {
  /** ordenes enviadas antes de apagarse solo */
  max: number;
  /** tiempo en el libro antes de cancelar (ms) */
  restMs: number;
  minUsd: number;
  minShares: number;
  /** tope de compras por market (USDC) */
  maxMarketUsd: number;
  tick: number;
  /** espera de los eventos tras cancelar (ejecuciones de ultimo momento, confirmaciones) */
  settleMs: number;
}

/** Lo que el check necesita del que firma (LiveTrader) */
export interface ProbeTrader {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  postLimitOrder(token: string, side: "buy" | "sell", price: number, size: number): Promise<ClobCall & { signMs: number }>;
  cancelOrder(orderId: string): Promise<ClobCall>;
  on(event: "user", cb: (ev: unknown) => void): unknown;
}

export interface ProbeDeps {
  trader: ProbeTrader;
  quote: (token: string) => { bid: number | null; ask: number | null };
  /** tamano actual del nivel en el libro publico */
  levelSize: (token: string, side: "bid" | "ask", price: number) => number;
  /** reloj de Binance */
  now: () => number;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const r1 = (v: number) => round(v, 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

/**
 * Precio maker: compra = mejor bid + 1 tick sin llegar al ask (spread de 1 tick: el mejor bid); venta = mejor ask - 1 tick sin
 * llegar al bid. null si falta el libro o el precio queda fuera de [tick, 1 - tick]. Funcion pura.
 */
export function makerPrice(action: "buy" | "sell", bid: number | null, ask: number | null, tick: number): number | null {
  if (bid === null || ask === null || ask <= bid) return null;
  const p = action === "buy" ? Math.min(bid + tick, ask - tick) : Math.max(ask - tick, bid + tick);
  const v = round(p, 6);
  return v >= tick - 1e-9 && v <= 1 - tick + 1e-9 ? v : null;
}

/** Tokens de una compra: max(minUsd / precio, minShares), redondeado hacia arriba a 2 decimales. Funcion pura. */
export function makerSize(price: number, minUsd: number, minShares: number): number {
  return Math.ceil(round(Math.max(minUsd / price, minShares) * 100, 6)) / 100;
}

/** Evento `order` del canal de usuario -> id, tipo, marca de tiempo (ms) y tokens ejecutados acumulados. Funcion pura. */
export function orderEvent(ev: unknown): { id: string; type: "PLACEMENT" | "UPDATE" | "CANCELLATION"; at: number | null; msPrecision: boolean; matched: number | null } | null {
  const e = ev as { event_type?: string; id?: string; type?: string; timestamp?: unknown; size_matched?: unknown } | null;
  if (!e || e.event_type !== "order" || !e.id) return null;
  const type = String(e.type ?? "").toUpperCase();
  if (type !== "PLACEMENT" && type !== "UPDATE" && type !== "CANCELLATION") return null;
  const raw = Number(e.timestamp);
  const m = Number(e.size_matched);
  return { id: e.id, type, at: ts(e.timestamp), msPrecision: Number.isFinite(raw) && raw >= 1e12, matched: Number.isFinite(m) ? m : null };
}

/** Evento `trade` del canal de usuario: tokens ejecutados de `orderId` como maker en ese trade (id del trade para no contar dos veces). Funcion pura. */
export function makerFill(ev: unknown, orderId: string): { tradeId: string; shares: number } | null {
  const e = ev as { event_type?: string; id?: string; maker_orders?: { order_id?: string; matched_amount?: unknown }[] } | null;
  if (!e || e.event_type !== "trade" || !Array.isArray(e.maker_orders)) return null;
  const mine = e.maker_orders.filter((o) => o.order_id === orderId);
  if (!mine.length) return null;
  const shares = mine.reduce((s, o) => s + (Number(o.matched_amount) || 0), 0);
  return { tradeId: String(e.id ?? ""), shares };
}

/** Respuesta de POST /order: id, estado y mensaje. Funcion pura. */
export function parsePost(text: string): { orderId: string | null; status: string | null; error: string | null } {
  try {
    const b = JSON.parse(text) as { orderID?: string; status?: string; errorMsg?: string; error?: string; success?: boolean };
    const error = b.errorMsg || b.error || (b.success === false ? "rechazada" : null);
    return { orderId: b.orderID || null, status: b.status ?? null, error: error || null };
  } catch {
    return { orderId: null, status: null, error: text.slice(0, 200) || "respuesta vacia" };
  }
}

/** Respuesta de DELETE /order: ¿se cancelo esa orden? Funcion pura. */
export function parseCancel(text: string, orderId: string): { ok: boolean; error: string | null } {
  try {
    const b = JSON.parse(text) as { canceled?: string[]; not_canceled?: Record<string, string>; error?: string };
    if (b.canceled?.includes(orderId)) return { ok: true, error: null };
    const why = b.not_canceled?.[orderId] ?? b.error ?? "no cancelada";
    return { ok: false, error: why };
  } catch {
    return { ok: false, error: text.slice(0, 200) || "respuesta vacia" };
  }
}

/** Lo que se sabe de una orden por el canal de usuario (puede llegar antes que la respuesta HTTP) */
interface Seen {
  place?: number;
  placeTs?: number | null;
  cancel?: number;
  cancelTs?: number | null;
  firstFill?: number;
  /** tokens ejecutados: max(size_matched de los eventos de orden, suma de los trades) */
  matched: number;
  tradeIds: Set<string>;
  tradeSum: number;
}

/** Nivel del libro vigilado para una orden: aparece (tamano >= min) o desaparece (tamano <= max) */
interface Watch {
  token: string;
  side: "bid" | "ask";
  price: number;
  min?: number;
  max?: number;
  at: number | null;
}

const EMPTY_POS = (): Record<PmSide, number> => ({ up: 0, down: 0 });

export class MakerProbe extends EventEmitter<{ sample: [MakerProbeSample]; state: [MakerProbeState] }> {
  readonly history: MakerProbeSample[] = [];
  private enabled = false;
  private engine: LiveEngine = "c";
  private done = 0;
  private currentSlug: string | null = null;
  private spent = 0;
  private position = EMPTY_POS();
  /** un lado con una orden en curso no recibe otra (las senales que llegan mientras se omiten) */
  private busy = new Set<PmSide>();
  private seen = new Map<string, Seen>();
  /** ordenes vivas (para cancelarlas si se apaga el servidor) */
  private live = new Set<string>();
  private watches = new Set<Watch>();

  constructor(
    private readonly opts: MakerProbeOptions,
    private readonly d: ProbeDeps,
  ) {
    super();
    d.trader.on("user", (ev) => this.onUser(ev));
  }

  state(): MakerProbeState {
    const t = this.d.trader;
    return {
      available: t.enabled,
      reason: t.enabled ? null : t.disabledReason,
      enabled: this.enabled,
      engine: this.engine,
      done: this.done,
      max: this.opts.max,
      restMs: this.opts.restMs,
      minUsd: this.opts.minUsd,
      minShares: this.opts.minShares,
      maxMarketUsd: this.opts.maxMarketUsd,
      currentSlug: this.currentSlug,
      spentUsd: round(this.spent, 4),
      position: { up: round(this.position.up, 4), down: round(this.position.down, 4) },
    };
  }

  /** Activa / desactiva (con el motor a seguir). Devuelve un error legible o null. */
  setEnabled(on: boolean, engine?: LiveEngine): string | null {
    if (engine === "a" || engine === "c") this.engine = engine;
    if (on && !this.d.trader.enabled) return `no disponible: ${this.d.trader.disabledReason}`;
    if (on && !this.enabled) {
      this.enabled = true;
      this.done = 0;
      console.log(`[maker-check] ACTIVADO: motor ${this.engine.toUpperCase()}, max(${this.opts.minUsd} USDC, ${this.opts.minShares} tokens), cancela a los ${this.opts.restMs} ms, tope ${this.opts.max} ordenes`);
    } else if (!on && this.enabled) this.disable("apagado por el usuario");
    this.emit("state", this.state());
    return null;
  }

  private disable(why: string) {
    if (!this.enabled) return;
    this.enabled = false;
    console.log(`[maker-check] desactivado (${why})`);
    this.emit("state", this.state());
  }

  /** Cambio de market en curso: posicion y gasto empiezan de cero (los tokens anteriores los liquida Polymarket). */
  onMarket(current: PmMarket | null): void {
    const slug = current?.slug ?? null;
    if (slug === this.currentSlug) return;
    this.currentSlug = slug;
    this.spent = 0;
    this.position = EMPTY_POS();
    this.emit("state", this.state());
  }

  /** Senales de un motor en un paso: solo cuentan las del motor elegido y del market en curso. */
  onSignals(engine: LiveEngine, signals: PmSignal[], market: PmMarket | null): void {
    if (!this.enabled || engine !== this.engine || !market || market.slug !== this.currentSlug || !market.upToken) return;
    for (const s of signals) {
      if (s.slug !== market.slug) continue;
      if (this.done >= this.opts.max) break;
      void this.run(s, market).catch((e) => console.error(`[maker-check] ${e instanceof Error ? e.message : e}`));
    }
  }

  private onUser(ev: unknown) {
    const arrived = this.d.now();
    const o = orderEvent(ev);
    if (o) {
      const s = this.get(o.id);
      const at = o.msPrecision ? o.at : null;
      if (o.type === "PLACEMENT" && s.place === undefined) Object.assign(s, { place: arrived, placeTs: at });
      if (o.type === "CANCELLATION" && s.cancel === undefined) Object.assign(s, { cancel: arrived, cancelTs: at });
      if (o.matched !== null && o.matched > s.matched) {
        s.matched = o.matched;
        s.firstFill ??= arrived;
      }
    }
    // ejecuciones como maker: solo de ordenes que este check conoce
    for (const id of this.live) {
      const f = makerFill(ev, id);
      if (!f) continue;
      const s = this.get(id);
      if (f.tradeId && s.tradeIds.has(f.tradeId)) continue; // el mismo trade llega de nuevo al cambiar de estado (MINED, CONFIRMED)
      s.tradeIds.add(f.tradeId);
      s.tradeSum += f.shares;
      s.matched = Math.max(s.matched, s.tradeSum);
      s.firstFill ??= arrived;
    }
  }

  private get(id: string): Seen {
    let s = this.seen.get(id);
    if (!s) {
      this.seen.set(id, (s = { matched: 0, tradeIds: new Set(), tradeSum: 0 }));
      if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value!);
    }
    return s;
  }

  /** Cambio de nivel del libro publico (del tracker): detecta cuando una orden aparece y desaparece. */
  onLevel(token: string, side: "bid" | "ask", price: number, size: number): void {
    for (const w of this.watches) {
      if (w.at !== null || w.token !== token || w.side !== side || Math.abs(w.price - price) > 1e-9) continue;
      if ((w.min !== undefined && size >= w.min - 1e-6) || (w.max !== undefined && size <= w.max + 1e-6)) w.at = this.d.now();
    }
  }

  private async waitFor(ms: number, cond: () => boolean): Promise<void> {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(10);
  }

  private finish(s: MakerProbeSample) {
    this.history.push(s);
    if (this.history.length > 60) this.history.shift();
    this.emit("sample", s);
    this.emit("state", this.state());
    const f = (v: number | null) => (v === null ? "–" : `${v}`);
    console.log(
      `[maker-check] ${s.action} ${s.side} ${s.size} a ${s.price} (senal ${s.signalPrice}) -> ${s.status}${s.filledShares ? ` ${s.filledShares} tk` : ""} · post ${f(s.postMs)} · libro ${f(s.bookMs)} · 1a ejec ${f(s.firstFillMs)} · cancel ${f(s.cancelMs)} · fuera ${f(s.bookGoneMs)}${s.error ? ` (${s.error})` : ""}`,
    );
  }

  private async run(sig: PmSignal, m: PmMarket): Promise<void> {
    const { tick, minUsd, minShares } = this.opts;
    const token = sig.side === "up" ? m.upToken : m.downToken;
    const q = this.d.quote(token);
    const price = makerPrice(sig.action, q.bid, q.ask, tick);
    const s: MakerProbeSample = {
      signalId: sig.id, engine: this.engine, slug: m.slug, action: sig.action, side: sig.side, signalTime: sig.time, signalPrice: sig.price,
      price: price ?? 0, size: 0, time: null, signMs: null, postMs: null, postStatus: null, orderStatus: null, orderId: null,
      userAckMs: null, bookMs: null, firstFillMs: null, filledShares: 0, cancelMs: null, cancelStatus: null, userCancelMs: null, bookGoneMs: null,
      exchangePlaceMs: null, exchangeCancelMs: null, status: "skipped", error: null,
    };
    const skip = (why: string) => this.finish({ ...s, error: why });
    if (this.busy.has(sig.side)) return skip("ya hay una orden de ese lado en curso");
    if (price === null) return skip("sin libro util");
    if (sig.action === "buy") {
      s.size = makerSize(price, minUsd, minShares);
      if (this.spent + s.size * price > this.opts.maxMarketUsd + 1e-9) return skip(`tope por market (${round(this.spent, 2)} de ${this.opts.maxMarketUsd} USDC)`);
    } else {
      s.size = Math.floor(this.position[sig.side] * 100) / 100;
      if (s.size < minShares) return skip(s.size > 0 ? `solo ${s.size} tokens (minimo ${minShares})` : "sin tokens comprados por el check");
    }

    this.busy.add(sig.side);
    this.done++;
    if (this.done >= this.opts.max) this.disable(`${this.done} ordenes enviadas`);
    const side = sig.action === "buy" ? "bid" : "ask";
    const place: Watch = { token, side, price, min: this.d.levelSize(token, side, price) + s.size, at: null };
    this.watches.add(place);
    let id: string | null = null;
    try {
      const post = await this.d.trader.postLimitOrder(token, sig.action, price, s.size);
      s.time = post.sentAt;
      s.signMs = post.signMs;
      s.postMs = post.ms;
      s.postStatus = post.status;
      const p = parsePost(post.text);
      s.orderStatus = p.status;
      s.orderId = p.orderId;
      if (!p.orderId || p.error) {
        s.status = "rejected";
        s.error = p.error ?? `HTTP ${post.status}`;
        return this.finish(s);
      }
      id = p.orderId;
      this.live.add(id);
      // en el libro hasta `restMs` desde el envio, o hasta que se llene entera
      await this.waitFor(Math.max(0, post.sentAt + this.opts.restMs - this.d.now()), () => this.get(id!).matched >= s.size - 1e-6);
      const seen = this.get(id);
      if (seen.place !== undefined) s.userAckMs = r1(seen.place - post.sentAt);
      if (seen.placeTs != null) s.exchangePlaceMs = r1(seen.placeTs - post.sentAt);
      if (place.at !== null) s.bookMs = r1(place.at - post.sentAt);

      if (seen.matched < s.size - 1e-6) {
        // cancelar lo que quede (dos intentos: nunca debe quedarse en el libro)
        const gone: Watch = { token, side, price, max: Math.max(0, this.d.levelSize(token, side, price) - (s.size - seen.matched)), at: null };
        this.watches.add(gone);
        let c = await this.d.trader.cancelOrder(id);
        let pc = parseCancel(c.text, id);
        if (!pc.ok && !/match|fill/i.test(pc.error ?? "")) {
          await sleep(300);
          c = await this.d.trader.cancelOrder(id);
          pc = parseCancel(c.text, id);
        }
        s.cancelMs = c.ms;
        s.cancelStatus = c.status;
        if (!pc.ok) {
          s.error = `cancelacion: ${pc.error}`;
          console.error(`[maker-check] !!! no se pudo cancelar ${id}: ${pc.error}`);
        }
        await this.waitFor(this.opts.settleMs, () => this.get(id!).cancel !== undefined && gone.at !== null);
        const g = this.get(id);
        if (g.cancel !== undefined) s.userCancelMs = r1(g.cancel - c.sentAt);
        if (g.cancelTs != null) s.exchangeCancelMs = r1(g.cancelTs - c.sentAt);
        if (gone.at !== null) s.bookGoneMs = r1(gone.at - c.sentAt);
        this.watches.delete(gone);
        if (pc.ok) this.live.delete(id);
      } else this.live.delete(id);

      const end = this.get(id);
      s.filledShares = round(Math.min(s.size, end.matched), 4);
      if (end.firstFill !== undefined) s.firstFillMs = r1(end.firstFill - post.sentAt);
      s.status = s.filledShares >= s.size - 1e-6 ? "filled" : s.filledShares > 0 ? "partial" : "unfilled";
      if (sig.action === "buy") {
        this.position[sig.side] += s.filledShares;
        this.spent += s.filledShares * price;
      } else this.position[sig.side] = Math.max(0, this.position[sig.side] - s.filledShares);
      this.finish(s);
    } catch (e) {
      s.status = "error";
      s.error = e instanceof Error ? e.message : String(e);
      if (id && this.live.has(id)) {
        const c = await this.d.trader.cancelOrder(id).catch(() => null);
        if (c && parseCancel(c.text, id).ok) this.live.delete(id);
        else {
          console.error(`[maker-check] !!! la orden ${id} puede seguir en el libro`);
          this.disable("error con una orden viva");
        }
      }
      this.finish(s);
    } finally {
      this.watches.delete(place);
      this.busy.delete(sig.side);
    }
  }

  /** Al apagar el servidor: deja de operar y cancela las ordenes vivas. */
  async stop(): Promise<void> {
    this.enabled = false;
    await Promise.all([...this.live].map((id) => this.d.trader.cancelOrder(id).catch(() => undefined)));
  }
}
