import { EventEmitter } from "node:events";
import type { CvdPoint, FootprintBar, OrderflowSignal, PmDecision, PmMarket, PmPoint, PmRecord, PmSignal, UpstreamState } from "@updown/protocol";
import type { PolymarketApi } from "./api.js";
import { flowContext } from "./model.js";
import { computePnl, DEFAULT_STRATEGY, SignalEngine, type StrategyConfig } from "./strategy.js";

/** Datos de flujo de Binance que se archivan junto a cada market. */
export interface FlowSource {
  bars(): FootprintBar[];
  cvd(): CvdPoint[];
  signals(): OrderflowSignal[];
}

/** Mejor bid/ask de un token; `time` = marca de tiempo de Polymarket (ms) si la trae el mensaje */
export interface BookQuote {
  token: string;
  bid: number | null;
  ask: number | null;
  time?: number | null;
}

/** Lo minimo que el tracker necesita de un cliente de libro (BookClient o un doble en pruebas). */
export interface BookLike {
  readonly state: UpstreamState;
  start(): void;
  stop(): void;
  on(event: "quote", cb: (q: BookQuote) => void): unknown;
  on(event: "state", cb: (s: UpstreamState) => void): unknown;
}

export interface TrackerOptions {
  /** duracion del market (5 min) */
  marketMs: number;
  /** prefijo del slug, p. ej. `btc-updown-5m` */
  slugPrefix: string;
  /** markets terminados que se guardan */
  historyMax: number;
  /** espera tras el fin del market para archivar (deja cerrar la ultima barra y sus senales) */
  graceMs: number;
  /** reintento de peticiones HTTP pendientes */
  retryMs: number;
  /** maximo de reintentos para obtener el resultado oficial */
  resolveTries: number;
  /** tope de muestras de 1 s del market en curso */
  pointsMax: number;
  /** reglas del motor de senales (por defecto `DEFAULT_STRATEGY`) */
  strategy?: StrategyConfig;
}

export interface TrackerEvents {
  /** cambio en current/next */
  markets: [PmMarket | null, PmMarket | null];
  point: [PmPoint];
  /** senal de compra/venta del motor */
  signal: [PmSignal];
  /** por que decidio el motor lo que decidio en ese segundo (slug del market, decision) */
  decision: [string, PmDecision];
  /** cotizacion recibida del libro del market en curso (para el motor sincronizado) */
  quote: [BookQuote];
  /** market archivado o con resultado actualizado */
  record: [PmRecord];
  /** estado de la conexion con el libro de Polymarket */
  status: [UpstreamState];
}

export const slotStart = (now: number, marketMs: number) => Math.floor(now / marketMs) * marketMs;

/**
 * El market esta completo si el servidor tuvo datos (Chainlink, Binance y precios de ambos tokens) durante los
 * 5 minutos: sin huecos de mas de `maxGapMs`, empezando y acabando en los bordes de la ventana, y al menos
 * `minShare` de los segundos con datos. Solo los completos se guardan en la base de datos. Funcion pura.
 */
export function isComplete(market: PmMarket, points: PmPoint[], maxGapMs = 3000, minShare = 0.98): boolean {
  const full = points.filter(
    (p) => p.chainlink !== null && p.binance !== null && (p.upBid !== null || p.upAsk !== null) && (p.downBid !== null || p.downAsk !== null),
  );
  if (!full.length) return false;
  if (full[0]!.time > market.start + maxGapMs || full[full.length - 1]!.time < market.end - maxGapMs) return false;
  for (let i = 1; i < full.length; i++) if (full[i]!.time - full[i - 1]!.time > maxGapMs) return false;
  return full.length >= minShare * ((market.end - market.start) / 1000);
}

/** Empaqueta lo ocurrido en la ventana [start, end) del market. Funcion pura. */
export function buildRecord(market: PmMarket, points: PmPoint[], flow: FlowSource, trades: PmSignal[] = []): PmRecord {
  const { start, end } = market;
  return {
    market: { ...market },
    points: points.slice(),
    bars: flow.bars().filter((b) => b.start >= start && b.start < end),
    cvd: flow.cvd().filter((p) => p.time > start && p.time <= end),
    signals: flow.signals().filter((s) => s.barStart >= start && s.barStart < end),
    trades: trades.slice(),
    pnl: computePnl(trades, market.result),
    complete: isComplete(market, points),
  };
}

/**
 * Sigue el market BTC Up/Down en curso (rota solo cada `marketMs`), muestrea los precios de los
 * tokens Up/Down cada segundo, y archiva en memoria cada market terminado junto al flujo de Binance.
 * Se mueve con `tick()` (1 Hz). Los tiempos vienen del reloj de Binance (`now`).
 */
export class PolymarketTracker extends EventEmitter<TrackerEvents> {
  current: PmMarket | null = null;
  next: PmMarket | null = null;
  points: PmPoint[] = [];
  /** senales del motor en el market en curso */
  trades: PmSignal[] = [];
  readonly history: PmRecord[] = [];

  private chainlink: number | null = null;
  private quotes = new Map<string, { bid: number | null; ask: number | null }>();
  private book?: BookLike;
  private bookFor = "";
  private finalizing: { market: PmMarket; points: PmPoint[]; trades: PmSignal[] }[] = [];
  private engine?: SignalEngine;
  /** basis Chainlink - Binance suavizado (EMA, vida media 60 s): la medida puntual oscila varios USD */
  private basisEma: number | null = null;
  private busy = new Set<string>();
  private lastTry = new Map<string, number>();
  private resolveCount = new Map<string, number>();

  constructor(
    private readonly api: PolymarketApi,
    private readonly flow: FlowSource,
    private readonly makeBook: (tokens: string[]) => BookLike,
    private readonly opts: TrackerOptions,
  ) {
    super();
  }

  setChainlink(price: number): void {
    this.chainlink = price;
  }

  /** Carga markets ya resueltos (de la base de datos) al arrancar, de antiguo a reciente. */
  restore(records: PmRecord[]): void {
    for (const r of records) this.history.push(r);
    while (this.history.length > this.opts.historyMax) this.history.shift();
  }

  /** Estado de la conexion del libro del market en curso */
  get upstream(): UpstreamState {
    return this.book?.state ?? "connecting";
  }

  private slug(start: number) {
    return `${this.opts.slugPrefix}-${start / 1000}`;
  }

  private blank(start: number, status: PmMarket["status"]): PmMarket {
    return {
      slug: this.slug(start),
      title: "",
      start,
      end: start + this.opts.marketMs,
      upToken: "",
      downToken: "",
      status,
      priceToBeat: null,
      closePrice: null,
      changePct: null,
      result: null,
    };
  }

  /** Llamar cada segundo con la hora de Binance. */
  tick(now: number): void {
    const slot = slotStart(now, this.opts.marketMs);
    if (this.current?.start !== slot) this.rotate(slot);
    if (this.next?.start !== slot + this.opts.marketMs) {
      this.next = this.blank(slot + this.opts.marketMs, "upcoming");
      this.emit("markets", this.current, this.next);
    }

    const cur = this.current!;
    this.fillMeta(cur, now);
    this.fillMeta(this.next!, now);
    this.fillPriceToBeat(cur, now);
    this.ensureBook(cur);
    this.sample(cur, now);
    this.finalize(now);
    this.resolveOpen(now);
  }

  private rotate(slot: number): void {
    if (this.current) {
      this.current.status = "resolving";
      this.finalizing.push({ market: this.current, points: this.points, trades: this.trades });
    }
    this.current = this.next?.start === slot ? this.next : this.blank(slot, "live");
    this.current.status = "live";
    this.next = null;
    this.points = [];
    this.trades = [];
    this.engine = new SignalEngine(this.current, this.opts.strategy ?? DEFAULT_STRATEGY);
    this.quotes.clear();
    this.book?.stop();
    this.book = undefined;
    this.bookFor = "";
    console.log(`[polymarket] market ${this.current.slug}`);
    this.emit("markets", this.current, this.next);
  }

  /** Throttle por clave: devuelve true si se puede lanzar la peticion ahora. */
  private canTry(key: string, now: number): boolean {
    if (this.busy.has(key)) return false;
    if (now - (this.lastTry.get(key) ?? 0) < this.opts.retryMs) return false;
    this.lastTry.set(key, now);
    return true;
  }

  private fillMeta(m: PmMarket, now: number): void {
    if (m.upToken || !this.canTry(`meta:${m.slug}`, now)) return;
    const key = `meta:${m.slug}`;
    this.busy.add(key);
    this.api
      .fetchMarket(m.slug)
      .then((info) => {
        if (!info) return;
        Object.assign(m, info);
        this.emit("markets", this.current, this.next);
      })
      .finally(() => this.busy.delete(key));
  }

  /** El price to beat (openPrice) aparece unos segundos despues de empezar el market: se reintenta. */
  private fillPriceToBeat(m: PmMarket, now: number): void {
    if (m.priceToBeat !== null || now < m.start) return;
    const key = `open:${m.slug}`;
    if (!this.canTry(key, now)) return;
    this.busy.add(key);
    this.api
      .fetchPriceToBeat(m.start, m.end)
      .then((open) => {
        if (open === null) return;
        m.priceToBeat = open;
        this.emit("markets", this.current, this.next);
      })
      .finally(() => this.busy.delete(key));
  }

  private ensureBook(m: PmMarket): void {
    if (!m.upToken || this.bookFor === m.slug) return;
    this.book?.stop();
    this.bookFor = m.slug;
    const book = this.makeBook([m.upToken, m.downToken]);
    book.on("quote", (q) => {
      if (this.book !== book) return;
      this.quotes.set(q.token, { bid: q.bid, ask: q.ask });
      this.emit("quote", q);
    });
    book.on("state", (st) => {
      if (this.book === book) this.emit("status", st);
    });
    this.book = book;
    book.start();
  }

  private sample(m: PmMarket, now: number): void {
    const up = this.quotes.get(m.upToken);
    const down = this.quotes.get(m.downToken);
    const ctx = flowContext(now, this.chainlink, this.flow.cvd(), this.flow.signals(), (this.opts.strategy ?? DEFAULT_STRATEGY).model);
    if (ctx.basis !== null) this.basisEma = this.basisEma === null ? ctx.basis : this.basisEma + (1 - Math.pow(0.5, 1 / 60)) * (ctx.basis - this.basisEma);
    const point: PmPoint = {
      time: now,
      chainlink: this.chainlink,
      upBid: up?.bid ?? null,
      upAsk: up?.ask ?? null,
      downBid: down?.bid ?? null,
      downAsk: down?.ask ?? null,
      binance: ctx.binance,
      basis: ctx.basis === null ? null : this.basisEma,
      sigma: ctx.sigma,
      flow: ctx.flow,
      pModel: null,
    };
    const r = this.engine?.step(point);
    point.pModel = r?.pUp ?? null;
    if (r) this.emit("decision", m.slug, r.decision);
    for (const sig of r?.signals ?? []) {
      this.trades.push(sig);
      this.emit("signal", sig);
    }
    this.points.push(point);
    if (this.points.length > this.opts.pointsMax) this.points.shift();
    this.emit("point", point);
  }

  private finalize(now: number): void {
    const ready = this.finalizing.filter((f) => now >= f.market.end + this.opts.graceMs);
    if (!ready.length) return;
    this.finalizing = this.finalizing.filter((f) => !ready.includes(f));
    for (const f of ready) {
      const record = buildRecord(f.market, f.points, this.flow, f.trades);
      this.history.push(record);
      if (this.history.length > this.opts.historyMax) this.history.shift();
      this.emit("record", record);
    }
  }

  /** Pide a Polymarket el resultado oficial (y apertura, cierre y %) de los markets archivados que aun no lo tienen. */
  private resolveOpen(now: number): void {
    for (const rec of this.history) {
      const m = rec.market;
      if (m.status === "closed") continue;
      const key = `result:${m.slug}`;
      if ((this.resolveCount.get(key) ?? 0) >= this.opts.resolveTries) continue;
      if (!this.canTry(key, now)) continue;
      this.resolveCount.set(key, (this.resolveCount.get(key) ?? 0) + 1);
      this.busy.add(key);
      this.api
        .fetchResult(m.slug, m.start, m.end)
        .then((r) => {
          if (!r) return;
          m.result = r.result;
          m.priceToBeat = r.openPrice ?? m.priceToBeat; // dato oficial final
          m.closePrice = r.closePrice;
          m.changePct = r.changePct;
          m.status = "closed";
          rec.pnl = computePnl(rec.trades, m.result);
          this.emit("record", rec);
        })
        .finally(() => this.busy.delete(key));
    }
  }

  stop(): void {
    this.book?.stop();
  }
}
