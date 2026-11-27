import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AggTrade, DepthColumn, PmEngineRun, PmMarketRow, PmRecord } from "@updown/protocol";

/** Margen de aggTrades guardado ANTES del inicio de cada market: el motor necesita historia (sigma 15 min, CVD, footprint) para reproducirse. */
export const TRADES_LEAD_MS = 10 * 60_000;
/** Tolerancia en los bordes al comprobar que los aggTrades cubren la ventana */
const EDGE_TOL_MS = 5000;

/** Version de la logica que produce flow/pModel/trades; subirla al cambiar modelo, detectores o reglas. */
export const ENGINE_VERSION = 3;

/** Metadatos de reproducibilidad que se guardan junto a cada market. */
export interface SaveMeta {
  version: number;
  /** configuracion efectiva (motor, detectores, rejilla del heatmap...) con la que se genero el market */
  params: unknown;
}

export interface TradeCoverage {
  count: number;
  first: number | null;
  last: number | null;
  /** true si los ids son correlativos (sin trades perdidos) y los extremos cubren [from, to] */
  ok: boolean;
}

/**
 * Base de datos (SQLite, modulo integrado de Node).
 *  - markets: cada market resuelto y COMPLETO (PmRecord en JSON + version y parametros del motor).
 *  - agg_trades: TODOS los aggTrades de Binance, de forma continua (footprint, CVD y senales se pueden rehacer desde ahi).
 *  - depth_columns: columnas del heatmap de liquidez (1 por muestreo); el libro historico no se puede recuperar.
 * Todo para poder reproducir y calibrar el motor (replayMarket, rebuildOrderflow).
 */
export class MarketStore {
  private readonly db: DatabaseSync;
  private tradeBuf: AggTrade[] = [];
  private depthBuf: { col: DepthColumn; step: number }[] = [];

  constructor(
    path: string,
    private readonly symbol = "",
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS markets (
        slug TEXT PRIMARY KEY,
        start INTEGER NOT NULL,
        result TEXT NOT NULL,
        price_to_beat REAL,
        close_price REAL,
        net REAL,
        saved_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS markets_start ON markets (start);
      CREATE TABLE IF NOT EXISTS agg_trades (
        id INTEGER PRIMARY KEY,
        time INTEGER NOT NULL,
        price REAL NOT NULL,
        qty REAL NOT NULL,
        sell INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agg_trades_time ON agg_trades (time);
      CREATE TABLE IF NOT EXISTS depth_columns (
        time INTEGER PRIMARY KEY,
        mid REAL NOT NULL,
        lo REAL NOT NULL,
        step REAL NOT NULL,
        q BLOB NOT NULL
      );
    `);
    // migracion: columnas de reproducibilidad en markets (bases creadas antes de este cambio)
    const cols = (this.db.prepare("PRAGMA table_info(markets)").all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, type: string) => {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE markets ADD COLUMN ${name} ${type}`);
    };
    add("engine_version", "INTEGER");
    add("params", "TEXT");
    add("trades_ok", "INTEGER");
    // columnas de resumen para listar sin leer el JSON (GET /api/markets)
    for (const [n, t] of [["delta", "REAL"], ["cvd_change", "REAL"], ["bull", "INTEGER"], ["bear", "INTEGER"], ["up_start", "REAL"], ["up_end", "REAL"], ["n_trades", "INTEGER"], ["invested", "REAL"], ["sold", "REAL"], ["change_pct", "REAL"], ["end_ms", "INTEGER"]] as const) add(n, t);
    // resumen de los motores C, D y E (A usa n_trades / invested / net; b_* queda de cuando existia el motor B)
    for (const e of ["b", "c", "d", "e"]) for (const [n, t] of [["trades", "INTEGER"], ["invested", "REAL"], ["net", "REAL"]] as const) add(`${e}_${n}`, t);
    this.backfillSummaries();
  }

  /** Rellena el resumen de los markets guardados antes de que existieran esas columnas. */
  private backfillSummaries(): void {
    const rows = this.db.prepare("SELECT slug, data FROM markets WHERE delta IS NULL OR end_ms IS NULL").all() as { slug: string; data: string }[];
    for (const row of rows) this.writeSummary(row.slug, JSON.parse(row.data) as PmRecord);
  }

  private writeSummary(slug: string, rec: PmRecord): void {
    const x = summarizeRecord(rec);
    this.db
      .prepare(
        `UPDATE markets SET delta = ?, cvd_change = ?, bull = ?, bear = ?, up_start = ?, up_end = ?, n_trades = ?, invested = ?, sold = ?, change_pct = ?, end_ms = ?,
         c_trades = ?, c_invested = ?, c_net = ?, d_trades = ?, d_invested = ?, d_net = ?, e_trades = ?, e_invested = ?, e_net = ? WHERE slug = ?`,
      )
      .run(
        x.delta, x.cvdChange, x.bull, x.bear, x.upStart, x.upEnd, x.trades, x.invested, x.sold, rec.market.changePct, rec.market.end,
        x.engines.c.trades, x.engines.c.invested, x.engines.c.net, x.engines.d.trades, x.engines.d.invested, x.engines.d.net, x.engines.e.trades, x.engines.e.invested, x.engines.e.net, slug,
      );
  }

  // ───────────── escritura continua (buffer + transaccion por lote) ─────────────

  addTrade(t: AggTrade): void {
    this.tradeBuf.push(t);
    if (this.tradeBuf.length >= 5000) this.flush();
  }

  addDepth(col: DepthColumn, step: number): void {
    this.depthBuf.push({ col, step });
    if (this.depthBuf.length >= 120) this.flush();
  }

  /** Vuelca los buffers a disco (el servidor lo llama cada segundo y al apagar). */
  flush(): void {
    if (!this.tradeBuf.length && !this.depthBuf.length) return;
    const trades = this.tradeBuf;
    const depth = this.depthBuf;
    this.tradeBuf = [];
    this.depthBuf = [];
    this.db.exec("BEGIN");
    try {
      const it = this.db.prepare("INSERT OR IGNORE INTO agg_trades (id, time, price, qty, sell) VALUES (?, ?, ?, ?, ?)");
      for (const t of trades) it.run(t.id, t.time, t.price, t.quantity, t.isBuyerMaker ? 1 : 0);
      const id = this.db.prepare("INSERT OR IGNORE INTO depth_columns (time, mid, lo, step, q) VALUES (?, ?, ?, ?, ?)");
      for (const { col, step } of depth) id.run(col.time, col.mid, col.lo, step, packQ(col.q));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ───────────── lectura ─────────────

  /** aggTrades con from <= time < to, en orden de id. */
  tradesBetween(from: number, to: number): AggTrade[] {
    this.flush();
    const rows = this.db
      .prepare("SELECT id, time, price, qty, sell FROM agg_trades WHERE time >= ? AND time < ? ORDER BY id")
      .all(from, to) as { id: number; time: number; price: number; qty: number; sell: number }[];
    return rows.map((r) => ({ id: r.id, symbol: this.symbol, price: r.price, quantity: r.qty, time: r.time, isBuyerMaker: r.sell === 1 }));
  }

  /** Columnas del heatmap con from <= time < to. */
  depthBetween(from: number, to: number): { step: number; columns: DepthColumn[] } {
    this.flush();
    const rows = this.db
      .prepare("SELECT time, mid, lo, step, q FROM depth_columns WHERE time >= ? AND time < ? ORDER BY time")
      .all(from, to) as { time: number; mid: number; lo: number; step: number; q: Uint8Array }[];
    return { step: rows[0]?.step ?? 0, columns: rows.map((r) => ({ time: r.time, mid: r.mid, lo: r.lo, q: unpackQ(r.q) })) };
  }

  /** ¿Los aggTrades guardados cubren [from, to] sin perder ninguno? (los ids de Binance son correlativos) */
  tradeCoverage(from: number, to: number): TradeCoverage {
    this.flush();
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(id) AS minId, MAX(id) AS maxId, MIN(time) AS t0, MAX(time) AS t1 FROM agg_trades WHERE time >= ? AND time <= ?")
      .get(from, to) as { n: number; minId: number | null; maxId: number | null; t0: number | null; t1: number | null };
    if (!r.n || r.minId === null || r.maxId === null || r.t0 === null || r.t1 === null) return { count: 0, first: null, last: null, ok: false };
    const contiguous = r.maxId - r.minId + 1 === r.n;
    return { count: r.n, first: r.t0, last: r.t1, ok: contiguous && r.t0 <= from + EDGE_TOL_MS && r.t1 >= to - EDGE_TOL_MS };
  }

  counts(): { markets: number; trades: number; depth: number } {
    this.flush();
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { markets: n("SELECT COUNT(*) AS n FROM markets"), trades: n("SELECT COUNT(*) AS n FROM agg_trades"), depth: n("SELECT COUNT(*) AS n FROM depth_columns") };
  }

  // ───────────── markets ─────────────

  /**
   * Guarda (o reemplaza) un market. Devuelve false si no cumple: debe estar resuelto y completo.
   * Anota si los aggTrades cubren la ventana con su margen previo (trades_ok): sin eso el market sirve para el motor
   * (los points bastan) pero el footprint no se puede reconstruir con fidelidad.
   */
  save(rec: PmRecord, meta: SaveMeta = { version: ENGINE_VERSION, params: null }): boolean {
    const m = rec.market;
    if (!rec.complete || m.status !== "closed" || m.result === null) return false;
    const tradesOk = this.tradeCoverage(m.start - TRADES_LEAD_MS, m.end).ok;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO markets (slug, start, result, price_to_beat, close_price, net, saved_at, data, engine_version, params, trades_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(m.slug, m.start, m.result, m.priceToBeat, m.closePrice, rec.pnl.net, Date.now(), JSON.stringify(rec), meta.version, JSON.stringify(meta.params), tradesOk ? 1 : 0);
    this.writeSummary(m.slug, rec);
    return true;
  }

  has(slug: string): boolean {
    return this.db.prepare("SELECT 1 FROM markets WHERE slug = ?").get(slug) !== undefined;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM markets").get() as { n: number }).n;
  }

  /** El market completo (points, barras, CVD, senales, operaciones) o null si no esta guardado. */
  get(slug: string): PmRecord | null {
    const r = this.db.prepare("SELECT data FROM markets WHERE slug = ?").get(slug) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as PmRecord) : null;
  }

  /** Los ultimos n markets guardados, de antiguo a reciente. */
  recent(n: number): PmRecord[] {
    const rows = this.db.prepare("SELECT data FROM markets ORDER BY start DESC LIMIT ?").all(n) as { data: string }[];
    return rows.reverse().map((r) => JSON.parse(r.data) as PmRecord);
  }

  /**
   * Filas resumen de los markets guardados (sin leer el JSON). `from`/`to` filtran por inicio (ms, to exclusivo);
   * `limit` acota (por defecto todos); `order` por inicio (desc = mas recientes primero).
   */
  list(opts: { from?: number; to?: number; limit?: number; order?: "asc" | "desc" } = {}): PmMarketRow[] {
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(
        `SELECT slug, start, result, price_to_beat, close_price, delta, cvd_change, bull, bear, up_start, up_end, n_trades, invested, sold, net, change_pct, end_ms, engine_version, trades_ok,
                c_trades, c_invested, c_net, d_trades, d_invested, d_net, e_trades, e_invested, e_net
         FROM markets WHERE start >= ? AND start < ? ORDER BY start ${order} LIMIT ?`,
      )
      .all(opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER, opts.limit ?? -1) as Record<string, number | string | null>[];
    const eng = (r: Record<string, number | string | null>, e: "c" | "d" | "e") => ({
      trades: (r[`${e}_trades`] as number | null) ?? 0,
      invested: (r[`${e}_invested`] as number | null) ?? 0,
      net: r[`${e}_net`] as number | null,
    });
    return rows.map((r) => {
      return {
        slug: r.slug as string,
        start: r.start as number,
        end: r.end_ms as number,
        priceToBeat: r.price_to_beat as number | null,
        closePrice: r.close_price as number | null,
        changePct: r.change_pct as number | null,
        result: r.result as "up" | "down",
        delta: r.delta as number,
        cvdChange: r.cvd_change as number,
        bull: r.bull as number,
        bear: r.bear as number,
        upStart: r.up_start as number | null,
        upEnd: r.up_end as number | null,
        trades: r.n_trades as number,
        invested: r.invested as number,
        sold: r.sold as number,
        net: r.net as number | null,
        engines: {
          a: { trades: r.n_trades as number, invested: r.invested as number, net: r.net as number | null },
          c: eng(r, "c"),
          d: eng(r, "d"),
          e: eng(r, "e"),
        },
        engineVersion: r.engine_version as number | null,
        tradesOk: r.trades_ok === 1,
      };
    });
  }

  /** Version, parametros y cobertura de aggTrades con que se guardo un market. */
  meta(slug: string): { version: number | null; params: unknown; tradesOk: boolean } | null {
    const r = this.db.prepare("SELECT engine_version AS v, params, trades_ok AS ok FROM markets WHERE slug = ?").get(slug) as
      | { v: number | null; params: string | null; ok: number | null }
      | undefined;
    if (!r) return null;
    return { version: r.v, params: r.params ? JSON.parse(r.params) : null, tradesOk: r.ok === 1 };
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

const midOf = (bid: number | null, ask: number | null): number | null => (bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask));

/** Resumen de un market para la tabla (se calcula al guardar, para no leer el JSON entero al listar). */
export function summarizeRecord(r: PmRecord): Omit<PmMarketRow, "slug" | "start" | "end" | "priceToBeat" | "closePrice" | "changePct" | "result" | "engineVersion" | "tradesOk"> {
  const bull = r.signals.filter((x) => x.bias === "bullish").length;
  const firstUp = r.points.find((p) => midOf(p.upBid, p.upAsk) !== null);
  const lastUp = [...r.points].reverse().find((p) => midOf(p.upBid, p.upAsk) !== null);
  const sum = (e?: PmEngineRun) => ({ trades: e?.trades.length ?? 0, invested: e?.pnl.invested ?? 0, net: e?.pnl.net ?? null });
  return {
    delta: r.bars.reduce((a, b) => a + b.delta, 0),
    cvdChange: r.cvd.length > 1 ? r.cvd[r.cvd.length - 1]!.cvd - r.cvd[0]!.cvd : 0,
    bull,
    bear: r.signals.length - bull,
    upStart: firstUp ? midOf(firstUp.upBid, firstUp.upAsk) : null,
    upEnd: lastUp ? midOf(lastUp.upBid, lastUp.upAsk) : null,
    trades: r.trades.length,
    invested: r.pnl.invested,
    sold: r.pnl.sold,
    net: r.pnl.net,
    engines: { a: { trades: r.trades.length, invested: r.pnl.invested, net: r.pnl.net }, c: sum(r.engines?.c), d: sum(r.engines?.d), e: sum(r.engines?.e) },
  };
}

/** Cantidades del heatmap como Float32 little-endian (4 bytes por bucket en vez de ~8-10 de texto). */
function packQ(q: number[]): Uint8Array {
  const a = new Float32Array(q);
  return new Uint8Array(a.buffer);
}

function unpackQ(b: Uint8Array): number[] {
  const copy = new Uint8Array(b); // alinea el buffer a 4 bytes
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4));
}
