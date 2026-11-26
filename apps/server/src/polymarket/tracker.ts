import { EventEmitter } from "node:events";
import type { CvdPoint, FootprintBar, OrderflowSignal, PmEngineId, PmMarket, PmPoint, PmRecord, PmSignal, UpstreamState } from "@updown/protocol";
import type { PolymarketApi } from "./api.js";
import { computePnl } from "./strategy.js";

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
  /** tope de muestras de 1 s por motor y market */
  pointsMax: number;
}

/** Muestras y senales de un motor en un market */
export interface EngineTrack {
  points: PmPoint[];
  trades: PmSignal[];
}
export type EngineTracks = Record<PmEngineId, EngineTrack>;
const emptyTracks = (): EngineTracks => ({ a: { points: [], trades: [] }, b: { points: [], trades: [] }, c: { points: [], trades: [] } });

export interface TrackerEvents {
  /** cambio en current/next */
  markets: [PmMarket | null, PmMarket | null];
  /** muestra de 1 s de un motor en el market en curso */
  point: [PmEngineId, PmPoint];
  /** senal de compra/venta de un motor */
  signal: [PmEngineId, PmSignal];
  /** cotizacion recibida del libro del market en curso (para los motores) */
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

/**
 * Empaqueta lo ocurrido en la ventana [start, end) del market: flujo de Binance y lo de cada motor
 * (A en `points`/`trades`, B y C en `engines`). La completitud se mide con las muestras de A. Funcion pura.
 */
export function buildRecord(market: PmMarket, tracks: EngineTracks, flow: FlowSource): PmRecord {
  const { start, end } = market;
  const run = (t: EngineTrack) => ({ points: t.points.slice(), trades: t.trades.slice(), pnl: computePnl(t.trades, market.result) });
  return {
    market: { ...market },
    points: tracks.a.points.slice(),
    bars: flow.bars().filter((b) => b.start >= start && b.start < end),
    cvd: flow.cvd().filter((p) => p.time > start && p.time <= end),
    signals: flow.signals().filter((s) => s.barStart >= start && s.barStart < end),
    trades: tracks.a.trades.slice(),
    pnl: computePnl(tracks.a.trades, market.result),
    engines: { b: run(tracks.b), c: run(tracks.c) },
    complete: isComplete(market, tracks.a.points),
  };
}

/**
 * Sigue el market BTC Up/Down en curso (rota solo cada `marketMs`), mantiene el libro de sus tokens, recoge lo
 * que producen los motores (A, B, C: `addStep`) y archiva en memoria cada market terminado junto al flujo de Binance.
 * Se mueve con `tick()` (1 Hz). Los tiempos vienen del reloj de Binance (`now`).
 */
export class PolymarketTracker extends EventEmitter<TrackerEvents> {
  current: PmMarket | null = null;
  next: PmMarket | null = null;
  readonly history: PmRecord[] = [];

  private book?: BookLike;
  private bookFor = "";
  private finalizing: PmMarket[] = [];
  /** muestras y senales de cada motor, por slug (los motores pueden empezar un market antes de que rote el tracker) */
  private tracks = new Map<string, EngineTracks>();
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

  private track(slug: string): EngineTracks {
    let t = this.tracks.get(slug);
    if (!t) this.tracks.set(slug, (t = emptyTracks()));
    return t;
  }

  /** Muestras del motor A en el market en curso (grafico en vivo) */
  get points(): PmPoint[] {
    return this.current ? this.track(this.current.slug).a.points : [];
  }
  get trades(): PmSignal[] {
    return this.current ? this.track(this.current.slug).a.trades : [];
  }
  /** Muestras y senales de un motor en el market en curso */
  live(id: PmEngineId): EngineTrack {
    return this.current ? this.track(this.current.slug)[id] : { points: [], trades: [] };
  }

  /** Registra el paso de un motor (su muestra y sus senales) en el market `slug`. */
  addStep(id: PmEngineId, slug: string, point: PmPoint, signals: PmSignal[]): void {
    const t = this.track(slug)[id];
    t.points.push(point);
    if (t.points.length > this.opts.pointsMax) t.points.shift();
    for (const sig of signals) {
      t.trades.push(sig);
      this.emit("signal", id, sig);
    }
    this.emit("point", id, point);
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
    this.finalize(now);
    this.resolveOpen(now);
  }

  private rotate(slot: number): void {
    if (this.current) {
      this.current.status = "resolving";
      this.finalizing.push(this.current);
    }
    this.current = this.next?.start === slot ? this.next : this.blank(slot, "live");
    this.current.status = "live";
    this.next = null;
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
      if (this.book === book) this.emit("quote", q);
    });
    book.on("state", (st) => {
      if (this.book === book) this.emit("status", st);
    });
    this.book = book;
    book.start();
  }

  private finalize(now: number): void {
    this.dropStale(now);
    const ready = this.finalizing.filter((m) => now >= m.end + this.opts.graceMs);
    if (!ready.length) return;
    this.finalizing = this.finalizing.filter((m) => !ready.includes(m));
    for (const m of ready) {
      const record = buildRecord(m, this.tracks.get(m.slug) ?? emptyTracks(), this.flow);
      this.tracks.delete(m.slug);
      this.history.push(record);
      if (this.history.length > this.opts.historyMax) this.history.shift();
      this.emit("record", record);
    }
  }

  /** Olvida pasos de motores de markets que ya no se van a archivar (p. ej. tras un reinicio a mitad de market). */
  private dropStale(now: number): void {
    for (const [slug, t] of this.tracks) {
      if (slug === this.current?.slug || slug === this.next?.slug || this.finalizing.some((m) => m.slug === slug)) continue;
      const last = Math.max(t.a.points.at(-1)?.time ?? 0, t.b.points.at(-1)?.time ?? 0, t.c.points.at(-1)?.time ?? 0);
      if (now - last > 2 * this.opts.marketMs) this.tracks.delete(slug);
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
          for (const e of Object.values(rec.engines ?? {})) e.pnl = computePnl(e.trades, m.result);
          this.emit("record", rec);
        })
        .finally(() => this.busy.delete(key));
    }
  }

  stop(): void {
    this.book?.stop();
  }
}
