import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync } from "node:fs";
import {
  CHANNELS,
  type AggTrade,
  type EnginesServerMessage,
  type MarketSource,
  type OrderflowSignal,
  type PmDecision,
  type PmEngineId,
  type PmEngineInfo,
  type PmEngineThresholds,
  type PmMarketsResponse,
  type LatencySample,
  type LatencyServerMessage,
  type PolymarketServerMessage,
  type TradingArmRequest,
  type TradingServerMessage,
  type UpstreamState,
} from "@updown/protocol";
import { config } from "../config.js";
import { DbBackup, type BackupConfig } from "../backup/backup.js";
import type { ExchangeClock } from "../clock.js";
import { PmBooks } from "../polymarket/pmBook.js";
import { serverStrategy } from "../polymarket/serverStrategy.js";
import { ENGINE_VERSION, MarketStore } from "../polymarket/store.js";
import { PmFeed, scheduleEngine, TimedEngine } from "../polymarket/timedEngine.js";
import { PolymarketTracker, slotStart, type FlowSource } from "../polymarket/tracker.js";
import { Channel } from "../ws/channel.js";
import type { PredictMarketApi } from "./api.js";
import { PredictBook } from "./book.js";
import type { PredictWs } from "./wsClient.js";
import type { PredictAccount } from "./account.js";
import type { PredictLatencyMonitor } from "./latency.js";
import { PredictLiveTrader } from "./liveTrader.js";

const TIMED_IDS = ["a", "c"] as const;
type TimedId = (typeof TIMED_IDS)[number];
const ENGINE_IDS: PmEngineId[] = ["a", "c"];
const MARKET_MS = 5 * 60_000;

export interface PredictVenueDeps {
  source: MarketSource;
  /** prefijo de logs de la fuente */
  tag: (name: string) => string;
  /** reloj de Binance de la fuente */
  clock: ExchangeClock;
  /** flujo de Binance de la fuente (se archiva con cada market) y sus senales de footprint (motores A y C) */
  flow: FlowSource;
  signals: () => OrderflowSignal[];
  /** compartidos por las fuentes: rondas por REST y precio Chainlink puntual por WS */
  api: PredictMarketApi;
  price: PredictWs;
  /** cuenta con la que se opera de verdad y latencia a su API (compartidas por las fuentes) */
  account: PredictAccount;
  latency: PredictLatencyMonitor;
  dbPath: string;
  backup: (BackupConfig & { enabled: boolean; restore: boolean; shutdownTimeoutMs: number }) | null;
  /** hubo aggTrades de Binance en [from, to) (base de la fuente) */
  coverage: (from: number, to: number) => boolean;
  symbol: string;
  /** la fuente termino el relleno inicial */
  isReady: () => boolean;
}

export type PredictVenue = Awaited<ReturnType<typeof createPredictVenue>>;

/**
 * Los mismos motores A y C (en papel) sobre las rondas BTC Up/Down 5m de Predict.fun, con el flujo de Binance de UNA fuente.
 * Es la misma pila que la de Polymarket en `source.ts` (tracker, PmFeed, TimedEngine, base, canales) con:
 *  - `PredictMarketApi` + `PredictBook` en lugar de la API y el libro de Polymarket (tokens sinteticos `<marketId>:up|down`);
 *  - el Chainlink PUNTUAL del WS de Predict en lugar del TWAP (Predict resuelve con el precio, no con un TWAP);
 *  - motores sin TWAP (`twapSeconds` 0, basis contra una media corta de Binance) y la comision de Predict (`serverStrategy("predict")`).
 * Sin compras reales. Canales `/ws/predict` y `/ws/predict-engines`; API `/api/predict/markets`. Ver docs/features/predict-markets.md.
 */
export async function createPredictVenue(d: PredictVenueDeps) {
  const tag = (name: string) => d.tag(`predict:${name}`);

  // Base propia (solo markets) y sus backups; con restore y sin base local se baja la ultima copia antes de abrirla
  const bk = d.backup;
  const dbBackup = bk && bk.s3.bucket && bk.s3.endpoint && bk.s3.accessKeyId && bk.s3.secretAccessKey ? new DbBackup(bk, d.dbPath) : null;
  if (dbBackup && bk?.restore) await dbBackup.restoreIfMissing();
  const marketStore = new MarketStore(d.dbPath, d.symbol, d.coverage);
  if (dbBackup && bk?.enabled) dbBackup.start();

  const strategy = serverStrategy("predict");
  const timedThresholds: PmEngineThresholds = { minEdge: strategy.minEdge, exitMargin: strategy.exitMargin, maxSpread: strategy.maxSpread, warmupS: strategy.warmupS, noEntryS: strategy.noEntryS };
  const engineInfo: PmEngineInfo[] = [
    ...TIMED_IDS.map((id) => ({ id, mode: id === "a" ? ("live" as const) : ("asOf" as const), delayMs: config.pmEngineDelayMs[id], thresholds: timedThresholds })),
  ];
  const engineParams = {
    venue: "predict",
    source: d.source,
    strategy,
    engines: engineInfo,
  };

  const tracker = new PolymarketTracker(d.api, d.flow, (tokens) => new PredictBook(config.predict.wsUrl, tokens), {
    marketMs: MARKET_MS,
    slugPrefix: config.predict.series,
    historyMax: config.pmHistory,
    graceMs: 5000,
    retryMs: 3000,
    resolveTries: 200,
    pointsMax: Math.ceil(MARKET_MS / 1000) + 60,
    tag: tag("tracker"),
  });
  tracker.restore(marketStore.recent(config.pmHistory));

  const feed = new PmFeed();
  const decisionsMax = Math.ceil(MARKET_MS / 1000) + 10;
  const engines3 = Object.fromEntries(
    TIMED_IDS.map((id) => [
      id,
      new TimedEngine({ id, mode: id === "a" ? "live" : "asOf", delayMs: config.pmEngineDelayMs[id], strategy, retentionMs: config.retentionMs, decisionsMax }, feed),
    ]),
  ) as Record<TimedId, TimedEngine>;
  // libro de los tokens de Predict (lo usan las compras reales)
  const books = new PmBooks();
  const engineTrack = (id: PmEngineId): { slug: string | null; decisions: PmDecision[] } => ({ slug: engines3[id].slug, decisions: engines3[id].decisions.slice() });
  console.log(`[${tag("db")}] ${d.dbPath}: ${marketStore.count()} markets guardados, ${tracker.history.length} cargados`);

  // ── Canales: mismos mensajes que los de Polymarket ──
  const upstream = (): UpstreamState => (tracker.upstream !== "connected" ? tracker.upstream : d.price.state);
  const marketsChannel = new Channel<PolymarketServerMessage>(() => ({
    type: "snapshot",
    current: tracker.current,
    next: tracker.next,
    points: tracker.points.slice(),
    trades: tracker.trades.slice(),
    engines: {
      c: { points: tracker.live("c").points.slice(), trades: tracker.live("c").trades.slice() },
    },
    history: tracker.history.slice(),
    historyMax: config.pmHistory,
    upstream: upstream(),
  }));
  const enginesChannel = new Channel<EnginesServerMessage>(() => ({
    type: "snapshot",
    thresholds: timedThresholds,
    engines: engineInfo,
    decisions: Object.fromEntries(ENGINE_IDS.map((id) => [id, engineTrack(id)])) as Record<PmEngineId, { slug: string | null; decisions: PmDecision[] }>,
  }));

  // ── Cableado (igual que Polymarket en source.ts, sin compras reales) ──
  const ready = d.isReady;
  const now = () => d.clock.now();
  const onPrice = (p: { time: number; value: number }) => feed.onChainlink(p.time, p.value);
  d.price.on("price", onPrice);
  tracker.on("quote", (q) => feed.onQuote(q.token, q.bid, q.ask, q.time ?? now()));
  tracker.on("book", (b) => books.get(b.token).snapshot(b.bids, b.asks, b.time ?? now()));
  tracker.on("level", (l) => books.get(l.token).set(l.side, l.price, l.size, l.time ?? now()));
  // Compras reales siguiendo al motor A o C DE ESTA FUENTE (interruptor propio, misma cuenta; ver liveTrader.ts)
  const liveTrader = new PredictLiveTrader(
    { ...config.predict.live, password: config.live.password },
    d.account,
    (marketId) => d.api.tradingInfo(marketId),
    (token) => (books.has(token) ? books.get(token) : null),
    now,
    tag("live"),
  );
  const tradingChannel = new Channel<TradingServerMessage>(() => ({ type: "snapshot", state: liveTrader.state(), trades: liveTrader.trades.slice() }));
  liveTrader.on("state", (state) => tradingChannel.broadcast({ type: "state", state }));
  liveTrader.on("trade", (trade) => tradingChannel.broadcast({ type: "trade", trade }));
  // Latencia a la API de ordenes: la misma para las dos fuentes (un solo monitor), sin check maker
  const latencyChannel = new Channel<LatencyServerMessage>(() => ({
    type: "snapshot",
    intervalMs: d.latency.opts.intervalMs,
    target: new URL(config.predict.restUrl).host,
    region: config.region,
    transport: "h2",
    authReady: d.latency.authReady,
    history: d.latency.history.slice(),
    historyMax: d.latency.opts.historyMax,
    upstream: d.latency.state,
  }));
  const onSample = (sample: LatencySample) => latencyChannel.broadcast({ type: "sample", sample });
  const onLatencyState = (upstream: UpstreamState) => latencyChannel.broadcast({ type: "status", upstream });
  d.latency.on("sample", onSample);
  d.latency.on("state", onLatencyState);

  for (const id of TIMED_IDS)
    engines3[id].on("step", (st) => {
      tracker.addStep(id, st.slug, st.point, st.signals);
      if (st.signals.length) liveTrader.onSignals(id, st.signals, tracker.current);
      enginesChannel.broadcast({ type: "decision", engine: id, slug: st.slug, decision: st.decision });
    });
  const status = () => marketsChannel.broadcast({ type: "status", upstream: upstream() });
  tracker.on("status", status);
  d.price.on("state", status);
  tracker.on("markets", (current, next) => {
    liveTrader.onMarket(current);
    if (ready()) marketsChannel.broadcast({ type: "markets", current, next });
  });
  tracker.on("point", (engine, point) => ready() && marketsChannel.broadcast({ type: "point", engine, point }));
  tracker.on("signal", (engine, signal) => ready() && marketsChannel.broadcast({ type: "signal", engine, signal }));
  tracker.on("record", (record) => {
    if (ready()) marketsChannel.broadcast({ type: "record", record });
    if (record.market.status === "closed" && record.complete && marketStore.save(record, { version: ENGINE_VERSION, params: engineParams })) {
      console.log(`[${tag("db")}] guardado ${record.market.slug} (${record.market.result}, pnl ${record.pnl.net})`);
    } else if (record.market.status === "closed" && !record.complete) {
      console.log(`[${tag("db")}] ${record.market.slug} incompleto: no se guarda`);
    }
  });

  const marketAt = (T: number) => {
    const slot = slotStart(T, MARKET_MS);
    return tracker.current?.start === slot ? tracker.current : tracker.next?.start === slot ? tracker.next : null;
  };
  const stops: (() => void)[] = [];

  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": config.allowedOrigin || "*" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  /** POST /api/predict/trading/arm con `x-trading-password` y `TradingArmRequest` (igual que el de Polymarket) */
  const armRequest = (req: IncomingMessage, res: ServerResponse) => {
    const h = {
      "access-control-allow-origin": config.allowedOrigin || "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-trading-password",
    };
    if (req.method === "OPTIONS") return void res.writeHead(204, h).end();
    if (req.method !== "POST") return void res.writeHead(405, h).end();
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { ...h, "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const pass = req.headers["x-trading-password"];
      if (!liveTrader.checkPassword(typeof pass === "string" ? pass : undefined)) {
        console.warn(`[${tag("live")}] contrasena incorrecta`);
        return void setTimeout(() => reply(401, { error: "contrasena incorrecta" }), 800);
      }
      let body: TradingArmRequest;
      try {
        body = JSON.parse(raw) as TradingArmRequest;
      } catch {
        return reply(400, { error: "cuerpo invalido" });
      }
      void liveTrader
        .setArmed(String(body.slug ?? ""), body.armed === true, { engine: body.engine, sizing: body.sizing })
        .then((err) => reply(err ? 409 : 200, err ? { error: err, state: liveTrader.state() } : { state: liveTrader.state() }));
    });
  };

  return {
    tracker,
    marketStore,
    /** canales de Predict de esta fuente (rutas sin el prefijo de la fuente) */
    channels: new Map<string, Channel<unknown>>([
      [CHANNELS.predict, marketsChannel as Channel<unknown>],
      [CHANNELS.predictEngines, enginesChannel as Channel<unknown>],
      [CHANNELS.predictTrading, tradingChannel as Channel<unknown>],
      [CHANNELS.predictLatency, latencyChannel as Channel<unknown>],
    ]),
    liveTrader,

    /** cada aggTrade de la fuente (tuberia `ingest`) */
    addTrade(t: AggTrade): void {
      for (const id of TIMED_IDS) engines3[id].addTrade(t);
    },

    /** `/api/predict/markets` y `/api/predict/markets/<slug>` (mismas respuestas que las de Polymarket) */
    handleHttp(req: IncomingMessage, res: ServerResponse, path: string, url: URL): boolean {
      // Interruptor de compras reales en Predict (motor A o C de esta fuente, market en curso). Protegido con TRADING_PASSWORD.
      if (path === "/api/predict/trading/arm") {
        armRequest(req, res);
        return true;
      }
      if (req.method !== "GET") return false;
      if (path === "/api/predict/markets") {
        const q = url.searchParams;
        const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
        const body: PmMarketsResponse = {
          total: marketStore.count(),
          markets: marketStore.list({ from: num("from"), to: num("to"), limit: num("limit"), order: q.get("order") === "asc" ? "asc" : "desc" }),
        };
        json(res, 200, body);
        return true;
      }
      const one = /^\/api\/predict\/markets\/([\w-]+)$/.exec(path);
      if (one) {
        const rec = marketStore.get(one[1]!);
        json(res, rec ? 200 : 404, rec ?? undefined);
        return true;
      }
      return false;
    },

    health() {
      let sizeMb: number | null = null;
      try {
        sizeMb = Math.round((statSync(d.dbPath).size / 1048576) * 10) / 10;
      } catch {}
      return {
        upstream: upstream(),
        book: tracker.upstream,
        price: d.price.state,
        rest: d.api.rest,
        current: tracker.current?.slug ?? null,
        priceToBeat: tracker.current?.priceToBeat ?? null,
        history: tracker.history.length,
        saved: marketStore.count(),
        db: { path: d.dbPath, sizeMb, backup: dbBackup ? { last: dbBackup.lastBackup() ? new Date(dbBackup.lastBackup()).toISOString() : null, lastError: dbBackup.lastError } : null },
        engines: Object.fromEntries(engineInfo.map((e) => [e.id, { market: engineTrack(e.id).slug, decisions: engineTrack(e.id).decisions.length }])),
        live: { enabled: liveTrader.enabled, disabledReason: liveTrader.disabledReason, armedSlug: liveTrader.state().armedSlug, balanceUsd: d.account.balanceUsd },
        latency: { authReady: d.latency.authReady, last: d.latency.history.at(-1) ?? null },
      };
    },

    /** Arranca los pasos de los motores (el tracker rota justo antes del paso del motor A, como en Polymarket) */
    start(): void {
      for (const id of TIMED_IDS)
        stops.push(
          scheduleEngine(
            engines3[id],
            now,
            (T) => {
              if (id === "a") tracker.tick(T);
              engines3[id].step(T, marketAt(T), d.signals());
              if (id === "a") {
                const keep = new Set([tracker.current?.upToken ?? "", tracker.current?.downToken ?? "", tracker.next?.upToken ?? "", tracker.next?.downToken ?? ""]);
                feed.prune(T - 60_000, keep);
                books.prune(keep);
              }
            },
            ready,
          ),
        );
    },

    async finalBackup(): Promise<void> {
      if (!dbBackup || !bk?.enabled) return;
      try {
        const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), bk.shutdownTimeoutMs));
        const r = await Promise.race([dbBackup.run(), timeout]);
        if (r === "timeout") console.error(`[${tag("backup")}] final sin terminar tras ${bk.shutdownTimeoutMs / 1000}s`);
        else console.log(`[${tag("backup")}] final ok: ${r.key} (${r.markets} markets)`);
      } catch (e) {
        console.error(`[${tag("backup")}] final fallo: ${e instanceof Error ? e.message : e}`);
      }
    },

    stop(): void {
      for (const s of stops) s();
      d.price.off("price", onPrice);
      d.price.off("state", status);
      d.latency.off("sample", onSample);
      d.latency.off("state", onLatencyState);
      tracker.stop();
      dbBackup?.stop();
      marketStore.flush();
      marketStore.close();
    },
  };
}
