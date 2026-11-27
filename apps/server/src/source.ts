import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import {
  CHANNELS,
  type AggTrade,
  type AggTradesServerMessage,
  type AnalysisServerMessage,
  type DepthServerMessage,
  type EnginesServerMessage,
  type LatencyServerMessage,
  type MakerProbeRequest,
  type MarketSource,
  type OrderflowServerMessage,
  type PmDecision,
  type PmEngineId,
  type PmEngineInfo,
  type PmEngineThresholds,
  type PmMarketsResponse,
  type PolymarketServerMessage,
  type TradingArmRequest,
  type TradingServerMessage,
  type UpstreamState,
} from "@updown/protocol";
import { config } from "./config.js";
import { AggTradeClient } from "./binance/aggTradeClient.js";
import { backfillTrades } from "./binance/backfill.js";
import { DepthClient, type DepthMode } from "./binance/depthClient.js";
import { OrderflowEngine } from "./analysis/engine.js";
import { DEFAULT_DETECTOR } from "./analysis/detectors.js";
import { AnalysisMonitor, DEFAULT_MONITOR } from "./analysis/monitor.js";
import { TradeBuffer } from "./store/tradeBuffer.js";
import { OrderBook } from "./store/orderBook.js";
import { DepthHistory } from "./store/depthHistory.js";
import { Channel } from "./ws/channel.js";
import { ExchangeClock } from "./clock.js";
import { HttpPolymarketApi } from "./polymarket/api.js";
import { BookClient } from "./polymarket/bookClient.js";
import type { ChainlinkClient } from "./polymarket/chainlinkClient.js";
import type { ChainlinkTwapClient } from "./polymarket/chainlinkTwapClient.js";
import { PolymarketTracker, slotStart } from "./polymarket/tracker.js";
import { ENGINE_VERSION, MarketStore } from "./polymarket/store.js";
import { serverFast, serverStrategy } from "./polymarket/serverStrategy.js";
import { FastRunner, scheduleFast } from "./polymarket/fastRunner.js";
import { DbBackup, type BackupConfig } from "./backup/backup.js";
import { PmFeed, scheduleEngine, TimedEngine } from "./polymarket/timedEngine.js";
import type { LatencyMonitor } from "./polymarket/latency.js";
import { LiveTrader } from "./polymarket/liveTrader.js";
import { MakerProbe } from "./polymarket/makerProbe.js";
import type { PredictMarketApi } from "./predict/api.js";
import { createPredictVenue, type PredictVenue } from "./predict/venue.js";
import type { PredictWs } from "./predict/wsClient.js";
import type { PredictAccount } from "./predict/account.js";
import type { PredictLatencyMonitor } from "./predict/latency.js";

/** Como se conecta una fuente a Binance y donde guarda lo suyo */
export interface SourceOptions {
  id: MarketSource;
  /** WS de aggTrades y del libro (en futuros son rutas distintas) */
  tradesWsUrl: string;
  depthWsUrl: string;
  restUrl: string;
  depthMode: DepthMode;
  depthSnapshotLimit: number;
  backfillPageDelayMs: number;
  dbPath: string;
  /** base de la generacion anterior que se archiva una vez (solo spot) */
  legacyDbPath: string | null;
  /** backups de esta base (null = desactivados) */
  backup: (BackupConfig & { enabled: boolean; restore: boolean; shutdownTimeoutMs: number }) | null;
  /** base de los markets de Predict de esta fuente y sus backups */
  predictDbPath: string;
  predictBackup: (BackupConfig & { enabled: boolean; restore: boolean; shutdownTimeoutMs: number }) | null;
}

/** Lo que comparten las dos fuentes: Polymarket es el mismo market para ambas; Predict, las mismas rondas y el mismo precio */
export interface SharedDeps {
  chainlink: ChainlinkClient | ChainlinkTwapClient;
  latencyMonitor: LatencyMonitor;
  /** null = sin motores de Predict (PREDICT_ENABLED o PREDICT_ENGINES en false) */
  predict: { api: PredictMarketApi; price: PredictWs; account: PredictAccount; latency: PredictLatencyMonitor } | null;
}

/** Ruta HTTP/WS sin la fuente: `/ws/futures/x` -> futures + `/ws/x`; el resto es spot. Funcion pura. */
export function splitSource(pathname: string): { source: MarketSource; path: string } {
  const m = /^\/(ws|api)\/futures(\/.*)$/.exec(pathname);
  return m ? { source: "futures", path: `/${m[1]}${m[2]}` } : { source: "spot", path: pathname };
}

const TIMED_IDS = ["a", "c"] as const;
type TimedId = (typeof TIMED_IDS)[number];
const ENGINE_IDS: PmEngineId[] = ["a", "c", "d", "e"];

export type Source = Awaited<ReturnType<typeof createSource>>;

/**
 * Una fuente completa (ADR 0016): Binance (trades, libro, orderflow, escenarios) -> motores A, C, D y E -> su base, sus backups,
 * sus compras reales y sus canales. Se crea una vez por fuente; nada de aqui se comparte entre fuentes salvo `shared`.
 * Llamar a `start()` cuando el servidor HTTP escuche.
 */
export async function createSource(opts: SourceOptions, shared: SharedDeps) {
  const { chainlink, latencyMonitor } = shared;
  const SYMBOL = config.symbol.toUpperCase();
  /** prefijo de los logs: spot mantiene los de siempre ([binance]); futures los marca ([futures:binance]) */
  const tag = (name: string) => (opts.id === "spot" ? name : `${opts.id}:${name}`);

  // ── Estado y motores ──
  const buffer = new TradeBuffer(config.retentionMs, config.tradesMax);
  const upstream = new AggTradeClient(opts.tradesWsUrl, config.symbol, tag("binance"));

  const book = new OrderBook();
  const depthHistory = new DepthHistory(config.depthHistory);
  const depthClient = new DepthClient(opts.depthWsUrl, opts.restUrl, config.symbol, book, opts.depthSnapshotLimit, opts.depthMode, tag("depth"));

  const engine = new OrderflowEngine({
    barMs: config.barMs,
    barHistory: config.barHistory,
    tick: config.footprintTick,
    retentionMs: config.retentionMs,
    detector: {
      ...DEFAULT_DETECTOR,
      tick: config.footprintTick,
      barMs: config.barMs,
      imbalanceRatio: config.imbalanceRatio,
      imbalanceMinVol: config.imbalanceMinVol,
      imbalanceMinStack: config.imbalanceMinStack,
    },
  });
  const monitor = new AnalysisMonitor(engine, {
    ...DEFAULT_MONITOR,
    lookbackMs: config.analysisLookbackMs,
    recentBars: config.analysisRecentBars,
    barMs: config.barMs,
  });

  /** reloj del exchange de ESTA fuente (los motores deciden en sus segundos) */
  const clock = new ExchangeClock();

  // Backups a S3/R2 (solo si hay bucket). Con restore y sin base local, se descarga la ultima copia antes de abrirla.
  const bk = opts.backup;
  const dbBackup = bk && bk.s3.bucket && bk.s3.endpoint && bk.s3.accessKeyId && bk.s3.secretAccessKey ? new DbBackup(bk, opts.dbPath) : null;
  if (dbBackup && bk?.restore) await dbBackup.restoreIfMissing();
  const marketStore = new MarketStore(opts.dbPath, SYMBOL);
  /** true si la carpeta de la base es otro sistema de archivos que la raiz (un volumen montado); en Railway debe serlo */
  const dbOnVolume = (() => {
    try {
      return statSync(dirname(opts.dbPath)).dev !== statSync("/").dev;
    } catch {
      return false;
    }
  })();
  if (process.env.RAILWAY_ENVIRONMENT && !dbOnVolume)
    console.error(`[${tag("db")}] !!! ${dirname(opts.dbPath)} NO es un volumen: la base se borrara en el proximo deploy. Solo quedaran los backups de R2.`);
  const dbInfo = () => {
    let sizeMb: number | null = null;
    try {
      sizeMb = Math.round((statSync(opts.dbPath).size / 1048576) * 10) / 10;
    } catch {}
    return {
      path: opts.dbPath,
      sizeMb,
      onVolume: dbOnVolume,
      backup:
        dbBackup && bk
          ? {
              enabled: bk.enabled,
              prefix: bk.prefix,
              intervalH: bk.intervalMs / 3600_000,
              keepH: bk.keepHours,
              last: dbBackup.lastBackup() ? new Date(dbBackup.lastBackup()).toISOString() : null,
              running: dbBackup.running,
              lastError: dbBackup.lastError,
            }
          : null,
    };
  };
  if (dbBackup && bk?.enabled) dbBackup.start();
  // La base de la generacion anterior (si existe) se sube una vez al archivo del bucket; nunca se borra ni se modifica
  if (dbBackup && opts.legacyDbPath)
    void dbBackup
      .archiveOnce(opts.legacyDbPath, process.env.RAILWAY_ENVIRONMENT ? "railway" : "local")
      .catch((e) => console.error(`[backup] no se pudo archivar la base anterior: ${e instanceof Error ? e.message : e}`));

  const strategy = serverStrategy();
  const fast = serverFast();
  const timedThresholds: PmEngineThresholds = { minEdge: strategy.minEdge, exitMargin: strategy.exitMargin, maxSpread: strategy.maxSpread, warmupS: strategy.warmupS, noEntryS: strategy.noEntryS };
  const engineInfo: PmEngineInfo[] = [
    ...TIMED_IDS.map((id) => ({ id, mode: id === "a" ? ("live" as const) : ("asOf" as const), delayMs: config.pmEngineDelayMs[id], kind: "taker" as const, thresholds: timedThresholds })),
    {
      id: "d",
      mode: "fast",
      delayMs: config.pmFast.tickMs,
      kind: "taker",
      thresholds: { minEdge: fast.predictive.minEdge, exitMargin: fast.predictive.exitMargin, maxSpread: fast.predictive.maxSpread, warmupS: fast.predictive.warmupS, noEntryS: fast.predictive.noEntryS },
    },
    {
      id: "e",
      mode: "fast",
      delayMs: config.pmFast.tickMs,
      kind: "maker",
      thresholds: { minEdge: fast.maker.edge, exitMargin: fast.maker.exitEdge, maxSpread: 1, warmupS: fast.maker.warmupS, noEntryS: fast.maker.noEntryS },
    },
  ];
  /** Parametros con los que se genera cada market guardado (para reproducirlo) */
  const engineParams = {
    source: opts.id,
    strategy,
    fast: { predictive: fast.predictive, maker: fast.maker, drift: fast.drift, paper: config.pmFast.paper, tickMs: config.pmFast.tickMs },
    engines: engineInfo,
    detector: { tick: config.footprintTick, barMs: config.barMs, imbalanceRatio: config.imbalanceRatio, imbalanceMinVol: config.imbalanceMinVol, imbalanceMinStack: config.imbalanceMinStack },
    depth: { step: config.depthStep, rangePct: config.depthRangePct, intervalMs: config.depthIntervalMs },
  };
  const tracker = new PolymarketTracker(
    new HttpPolymarketApi(config.pmGammaUrl, config.pmSiteUrl, config.pmSymbol, config.pmVariant, config.pmMarketMs, config.pmTwapSeconds),
    { bars: () => engine.allBars(), cvd: () => engine.cvdPoints, signals: () => engine.signals },
    (tokens) => new BookClient(config.pmBookWsUrl, tokens),
    {
      marketMs: config.pmMarketMs,
      slugPrefix: config.pmSlugPrefix,
      historyMax: config.pmHistory,
      graceMs: 5000,
      retryMs: 3000,
      resolveTries: 200,
      pointsMax: Math.ceil(config.pmMarketMs / 1000) + 60,
    },
  );
  tracker.restore(marketStore.recent(config.pmHistory));
  // Motores A y C: mismas reglas; deciden cada segundo de Binance (+ su retraso). A con lo ultimo recibido, C "a fecha".
  const feed = new PmFeed();
  const decisionsMax = Math.ceil(config.pmMarketMs / 1000) + 10;
  const engines3 = Object.fromEntries(
    TIMED_IDS.map((id) => [
      id,
      new TimedEngine({ id, mode: id === "a" ? "live" : "asOf", delayMs: config.pmEngineDelayMs[id], strategy, retentionMs: config.retentionMs, decisionsMax }, feed),
    ]),
  ) as Record<TimedId, TimedEngine>;
  // Motores D (predictivo, taker) y E (libro, maker): cada 100 ms con lo ultimo recibido (docs/features/predictive-engines.md)
  const fastRunner = new FastRunner(
    {
      tickMs: config.pmFast.tickMs,
      retentionMs: config.retentionMs,
      decisionsMax,
      twapSeconds: config.pmTwapSeconds,
      predictive: fast.predictive,
      maker: fast.maker,
      drift: fast.drift,
      paper: config.pmFast.paper,
    },
    feed,
    () => {
      if (!book.ready) return null;
      const { bids, asks } = book.sides();
      return { bids, asks, mid: (book.bestBid() + book.bestAsk()) / 2 };
    },
  );
  /** Registro de decisiones de un motor, sea por segundo (A, C) o rapido (D, E) */
  const engineTrack = (id: PmEngineId): { slug: string | null; decisions: PmDecision[] } =>
    id === "d" || id === "e" ? { slug: fastRunner.slug, decisions: fastRunner.decisions[id].slice() } : { slug: engines3[id].slug, decisions: engines3[id].decisions.slice() };
  console.log(`[${tag("polymarket")}] db ${opts.dbPath}: ${marketStore.count()} markets completos guardados, ${marketStore.counts().trades} aggTrades, ${tracker.history.length} cargados`);

  // Los mismos motores sobre las rondas de Predict.fun (precio puntual, sin TWAP), con el flujo de esta fuente
  let ready = false;
  const predict: PredictVenue | null = shared.predict
    ? await createPredictVenue({
        source: opts.id,
        tag,
        clock,
        flow: { bars: () => engine.allBars(), cvd: () => engine.cvdPoints, signals: () => engine.signals },
        signals: () => engine.signals,
        binanceBook: () => {
          if (!book.ready) return null;
          const { bids, asks } = book.sides();
          return { bids, asks, mid: (book.bestBid() + book.bestAsk()) / 2 };
        },
        api: shared.predict.api,
        price: shared.predict.price,
        account: shared.predict.account,
        latency: shared.predict.latency,
        dbPath: opts.predictDbPath,
        backup: opts.predictBackup,
        coverage: (from, to) => marketStore.tradeCoverage(from, to).ok,
        symbol: SYMBOL,
        isReady: () => ready,
      })
    : null;

  // ── Canales (uno por tipo de dato; cada uno envia snapshot al conectar) ──
  const aggTrades = new Channel<AggTradesServerMessage>(() => ({
    type: "snapshot",
    symbol: SYMBOL,
    retentionMs: config.retentionMs,
    trades: buffer.snapshot(),
    upstream: upstream.state,
  }));
  const depth = new Channel<DepthServerMessage>(() => ({
    type: "snapshot",
    symbol: SYMBOL,
    step: config.depthStep,
    retentionMs: config.retentionMs,
    columns: depthHistory.snapshot(),
    upstream: depthClient.state,
  }));
  const orderflow = new Channel<OrderflowServerMessage>(() => ({
    type: "snapshot",
    symbol: SYMBOL,
    tick: config.footprintTick,
    barMs: config.barMs,
    retentionMs: config.retentionMs,
    bars: engine.allBars(),
    cvd: engine.cvdPoints.slice(),
    signals: engine.signals.slice(),
    upstream: upstream.state,
  }));
  const analysis = new Channel<AnalysisServerMessage>(() => ({
    type: "snapshot",
    summary: monitor.last,
    history: monitor.history.slice(),
    upstream: upstream.state,
  }));

  /** Estado de Polymarket: conectado solo si lo estan el libro de tokens y el stream de Chainlink */
  const pmUpstream = (): UpstreamState => (tracker.upstream !== "connected" ? tracker.upstream : chainlink.state);
  const polymarket = new Channel<PolymarketServerMessage>(() => ({
    type: "snapshot",
    current: tracker.current,
    next: tracker.next,
    points: tracker.points.slice(),
    trades: tracker.trades.slice(),
    engines: {
      c: { points: tracker.live("c").points.slice(), trades: tracker.live("c").trades.slice() },
      d: { points: tracker.live("d").points.slice(), trades: tracker.live("d").trades.slice() },
      e: { points: tracker.live("e").points.slice(), trades: tracker.live("e").trades.slice(), orders: (tracker.live("e").orders ?? []).slice() },
    },
    history: tracker.history.slice(),
    historyMax: config.pmHistory,
    upstream: pmUpstream(),
  }));

  const engines = new Channel<EnginesServerMessage>(() => ({
    type: "snapshot",
    thresholds: timedThresholds,
    engines: engineInfo,
    decisions: Object.fromEntries(ENGINE_IDS.map((id) => [id, engineTrack(id)])) as Record<PmEngineId, { slug: string | null; decisions: PmDecision[] }>,
  }));

  // Compras reales siguiendo al motor A, C o D DE ESTA FUENTE: solo con su interruptor activado y solo en el market en curso.
  // Cada fuente tiene su propio interruptor y su propio tope por market (misma cartera).
  const liveTrader = new LiveTrader(
    {
      clobUrl: config.pmClobUrl,
      creds: { ...config.pmClob, address: config.pmSignerAddress, funder: config.pmFunderAddress },
      ...config.live,
    },
    () => clock.now(),
  );
  console.log(`[${tag("live")}] compras reales: ${liveTrader.enabled ? "disponibles (interruptor apagado)" : `desactivadas (${liveTrader.disabledReason})`}`);
  const trading = new Channel<TradingServerMessage>(() => ({ type: "snapshot", state: liveTrader.state(), trades: liveTrader.trades.slice() }));
  liveTrader.on("state", (state) => trading.broadcast({ type: "state", state }));
  liveTrader.on("trade", (trade) => trading.broadcast({ type: "trade", trade }));

  // Check maker: ordenes maker reales (las del motor E) siguiendo al motor A, C o D de esta fuente, solo con el interruptor
  const makerProbe = new MakerProbe(config.makerProbe, {
    trader: liveTrader,
    quote: (token) => {
      const b = fastRunner.books.has(token) ? fastRunner.books.get(token) : null;
      const q = b && b.time > 0 ? { bid: b.bestBid(), ask: b.bestAsk() } : feed.quote(token, Infinity);
      return { bid: q?.bid ?? null, ask: q?.ask ?? null };
    },
    levelSize: (token, side, price) => (fastRunner.books.has(token) ? fastRunner.books.get(token).sizeAt(side, price) : 0),
    now: () => clock.now(),
  });
  // La latencia al CLOB es la misma para las dos fuentes (un solo LatencyMonitor); el check maker es de cada una
  const latency = new Channel<LatencyServerMessage>(() => ({
    type: "snapshot",
    intervalMs: config.pmLatencyIntervalMs,
    target: new URL(config.pmClobUrl).host,
    region: config.region,
    transport: "h2",
    authReady: latencyMonitor.authReady,
    history: latencyMonitor.history.slice(),
    historyMax: config.pmLatencyHistory,
    upstream: latencyMonitor.state,
    maker: { state: makerProbe.state(), history: makerProbe.history.slice() },
  }));
  latencyMonitor.on("sample", (sample) => latency.broadcast({ type: "sample", sample }));
  latencyMonitor.on("state", (upstream) => latency.broadcast({ type: "status", upstream }));
  makerProbe.on("sample", (sample) => latency.broadcast({ type: "makerSample", sample }));
  makerProbe.on("state", (state) => latency.broadcast({ type: "makerState", state }));

  // ── Tuberia de trades: relleno historico + vivo, sin duplicados ──
  let lastId = 0;
  const pending: AggTrade[] = [];

  const ingest = (t: AggTrade) => {
    if (t.id <= lastId) return; // ya procesado (solape relleno/vivo)
    lastId = t.id;
    buffer.push(t);
    marketStore.addTrade(t);
    engine.ingest(t);
    for (const id of TIMED_IDS) engines3[id].addTrade(t);
    fastRunner.addTrade(t);
    predict?.addTrade(t);
    if (ready) aggTrades.broadcast({ type: "trade", trade: t });
  };

  upstream.on("trade", (t) => {
    clock.observe(t.time); // solo trades en vivo: el relleno historico no sirve para calibrar
    if (ready) ingest(t);
    else pending.push(t);
  });
  upstream.on("state", (s) => {
    const msg = { type: "status", upstream: s } as const;
    aggTrades.broadcast(msg);
    orderflow.broadcast(msg);
    analysis.broadcast(msg);
  });
  depthClient.on("state", (s) => depth.broadcast({ type: "status", upstream: s }));

  chainlink.on("price", (p) => feed.onChainlink(p.time, p.value));
  // sin marca de tiempo de Polymarket, se usa la hora de llegada (reloj de Binance estimado)
  tracker.on("quote", (q) => feed.onQuote(q.token, q.bid, q.ask, q.time ?? clock.now()));
  // libro completo y trades de Polymarket -> motores D y E (y su papel)
  tracker.on("book", (b) => fastRunner.onBook(b.token, b.bids, b.asks, b.time ?? clock.now()));
  tracker.on("level", (l) => {
    fastRunner.onLevel(l.token, l.side, l.price, l.size, l.time ?? clock.now(), clock.now());
    makerProbe.onLevel(l.token, l.side, l.price, l.size);
  });
  tracker.on("trade", (t) => fastRunner.onTrade(t, clock.now()));
  for (const id of TIMED_IDS) {
    engines3[id].on("step", (st) => {
      tracker.addStep(id, st.slug, st.point, st.signals);
      if (st.signals.length) {
        liveTrader.onSignals(id, st.signals, tracker.current);
        makerProbe.onSignals(id, st.signals, tracker.current);
      }
      engines.broadcast({ type: "decision", engine: id, slug: st.slug, decision: st.decision });
    });
  }
  fastRunner.on("step", (st) => {
    tracker.addStep(st.engine, st.slug, st.point, []);
    engines.broadcast({ type: "decision", engine: st.engine, slug: st.slug, decision: st.decision });
  });
  fastRunner.on("fills", (id, slug, signals) => tracker.addSignals(id, slug, signals));
  fastRunner.on("order", (slug, order) => tracker.addOrder(slug, order));
  // el motor D envia sus ordenes al decidir (no tras la ejecucion en papel): las compras reales las siguen si se elige D
  fastRunner.on("intent", (signals) => {
    liveTrader.onSignals("d", signals, tracker.current);
    makerProbe.onSignals("d", signals, tracker.current);
  });
  const pmStatus = () => polymarket.broadcast({ type: "status", upstream: pmUpstream() });
  tracker.on("status", pmStatus);
  chainlink.on("state", pmStatus);
  tracker.on("markets", (current, next) => {
    liveTrader.onMarket(current);
    makerProbe.onMarket(current);
    if (ready) polymarket.broadcast({ type: "markets", current, next });
  });
  tracker.on("point", (engine, point) => ready && polymarket.broadcast({ type: "point", engine, point }));
  tracker.on("signal", (engine, signal) => ready && polymarket.broadcast({ type: "signal", engine, signal }));
  tracker.on("order", (order) => ready && polymarket.broadcast({ type: "order", engine: "e", order }));
  tracker.on("record", (record) => {
    if (ready) polymarket.broadcast({ type: "record", record });
    // solo se guardan markets resueltos y con los 5 minutos completos (se reintenta al llegar el resultado)
    if (record.market.status === "closed" && record.complete && marketStore.save(record, { version: ENGINE_VERSION, params: engineParams })) {
      console.log(`[${tag("polymarket")}] guardado ${record.market.slug} (${record.market.result}, pnl ${record.pnl.net})`);
    } else if (record.market.status === "closed" && !record.complete) {
      console.log(`[${tag("polymarket")}] ${record.market.slug} incompleto: no se guarda`);
    }
  });

  engine.on("bar", (bar) => ready && orderflow.broadcast({ type: "bar", bar }));
  engine.on("cvd", (point) => ready && orderflow.broadcast({ type: "cvd", point }));
  engine.on("signal", (signal) => ready && orderflow.broadcast({ type: "signal", signal }));

  // ── Muestreos periodicos y pasos de los motores (arrancan en start) ──
  const timers: ReturnType<typeof setInterval>[] = [];
  const stopEngines: (() => void)[] = [];
  const marketAt = (T: number) => {
    const slot = slotStart(T, config.pmMarketMs);
    return tracker.current?.start === slot ? tracker.current : tracker.next?.start === slot ? tracker.next : null;
  };

  /** Canales de la fuente por ruta (sin el prefijo de la fuente: CHANNELS.x) */
  const channels = new Map<string, Channel<unknown>>([
    [CHANNELS.aggTrades, aggTrades as Channel<unknown>],
    [CHANNELS.depth, depth as Channel<unknown>],
    [CHANNELS.orderflow, orderflow as Channel<unknown>],
    [CHANNELS.analysis, analysis as Channel<unknown>],
    [CHANNELS.polymarket, polymarket as Channel<unknown>],
    [CHANNELS.engines, engines as Channel<unknown>],
    [CHANNELS.latency, latency as Channel<unknown>],
    [CHANNELS.trading, trading as Channel<unknown>],
    ...(predict?.channels ?? []),
  ]);

  const cors = (methods: string) => ({
    "access-control-allow-origin": config.allowedOrigin || "*",
    "access-control-allow-methods": methods,
    "access-control-allow-headers": "content-type, x-trading-password",
  });
  /** POST con contrasena de trading y cuerpo JSON (interruptores de compras reales y del check maker) */
  const passwordPost = <B>(req: IncomingMessage, res: ServerResponse, maxBytes: number, logTag: string, onBody: (body: B, reply: (status: number, body: unknown) => void) => void) => {
    const h = cors("POST, OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204, h).end();
    if (req.method !== "POST") return void res.writeHead(405, h).end();
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => {
      raw += d;
      if (raw.length > maxBytes) req.destroy();
    });
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { ...h, "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const pass = req.headers["x-trading-password"];
      if (!liveTrader.checkPassword(typeof pass === "string" ? pass : undefined)) {
        console.warn(`[${tag(logTag)}] contrasena incorrecta`);
        // un poco de espera ante contrasenas incorrectas: frena los intentos a ciegas
        return void setTimeout(() => reply(401, { error: "contrasena incorrecta" }), 800);
      }
      let body: B;
      try {
        body = JSON.parse(raw) as B;
      } catch {
        return reply(400, { error: "cuerpo invalido" });
      }
      onBody(body, reply);
    });
  };

  return {
    id: opts.id,
    marketStore,
    clock,
    tracker,
    /** motores de Predict de esta fuente (null si estan desactivados) */
    predict,
    channels,
    get ready() {
      return ready;
    },

    /**
     * API HTTP de la fuente. `path` va sin el prefijo de la fuente (`/api/markets`). Devuelve false si la ruta no es suya.
     */
    handleHttp(req: IncomingMessage, res: ServerResponse, path: string, url: URL): boolean {
      if (predict?.handleHttp(req, res, path, url)) return true;
      // Interruptor de compras reales (motor A, C o D de esta fuente, market en curso). Protegido con TRADING_PASSWORD.
      if (path === "/api/trading/arm") {
        passwordPost<TradingArmRequest>(req, res, 4096, "live", (body, reply) => {
          const err = liveTrader.setArmed(String(body.slug ?? ""), body.armed === true, { engine: body.engine, sizing: body.sizing });
          reply(err ? 409 : 200, err ? { error: err, state: liveTrader.state() } : { state: liveTrader.state() });
        });
        return true;
      }
      // Check maker (ordenes maker reales siguiendo a un motor de esta fuente). Misma contrasena que las compras reales.
      if (path === "/api/latency/maker") {
        passwordPost<MakerProbeRequest>(req, res, 1024, "maker-probe", (body, reply) => {
          const err = makerProbe.setEnabled(body.enabled === true, body.engine);
          reply(err ? 409 : 200, err ? { error: err, state: makerProbe.state() } : { state: makerProbe.state() });
        });
        return true;
      }
      if (path === "/api/markets" && req.method === "GET") {
        // resumen de todos los markets guardados (sin points/barras): ?limit=&from=&to=&order=asc|desc
        const q = url.searchParams;
        const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
        const body: PmMarketsResponse = {
          total: marketStore.count(),
          markets: marketStore.list({ from: num("from"), to: num("to"), limit: num("limit"), order: q.get("order") === "asc" ? "asc" : "desc" }),
        };
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": config.allowedOrigin || "*" });
        res.end(JSON.stringify(body));
        return true;
      }
      const one = /^\/api\/markets\/([\w-]+)$/.exec(path);
      if (one && req.method === "GET") {
        // un market guardado completo (para abrirlo en el grafico)
        const rec = marketStore.get(one[1]!);
        if (!rec) {
          res.writeHead(404, { "access-control-allow-origin": config.allowedOrigin || "*" }).end();
          return true;
        }
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": config.allowedOrigin || "*" });
        res.end(JSON.stringify(rec));
        return true;
      }
      return false;
    },

    /** Lo de esta fuente en /health */
    health() {
      return {
        ready,
        upstream: upstream.state,
        memory: { trades: buffer.size, depthColumns: depthHistory.size, bars: engine.bars.length, cvdPoints: engine.cvdPoints.length, signals: engine.signals.length },
        clients: Object.fromEntries([...channels].map(([path, ch]) => [path.replace("/ws/", ""), ch.size])),
        polymarket: {
          upstream: pmUpstream(),
          chainlink: chainlink.state,
          current: tracker.current?.slug ?? null,
          history: tracker.history.length,
          saved: marketStore.count(),
          engines: Object.fromEntries(engineInfo.map((e) => [e.id, { market: engineTrack(e.id).slug, decisions: engineTrack(e.id).decisions.length, mode: e.mode, delayMs: e.delayMs }])),
          openOrders: fastRunner.orders().filter((o) => o.status === "open" || o.status === "pending").length,
        },
        predict: predict ? predict.health() : { enabled: false },
        depth: { upstream: depthClient.state },
        db: dbInfo(),
        live: { enabled: liveTrader.enabled, armedSlug: liveTrader.state().armedSlug },
      };
    },

    /** Conecta a Binance, rellena la historia y arranca muestreos y motores */
    async start(): Promise<void> {
      upstream.start();
      depthClient.start();
      liveTrader.onMarket(tracker.current);
      makerProbe.onMarket(tracker.current);
      liveTrader.start();

      timers.push(
        setInterval(() => {
          if (depthClient.state !== "connected" || !depthClient.lastEventTime) return;
          const col = book.toColumn(config.depthStep, config.depthRangePct, depthClient.lastEventTime);
          if (!col) return;
          depthHistory.push(col);
          marketStore.addDepth(col, config.depthStep);
          depth.broadcast({ type: "column", column: col });
        }, config.depthIntervalMs),
        setInterval(() => {
          marketStore.flush();
          if (!ready) return;
          engine.tick();
          const r = monitor.update();
          if (!r) return;
          analysis.broadcast({ type: "summary", summary: r.summary });
          if (r.changed) analysis.broadcast({ type: "change", summary: r.summary });
        }, 1000),
      );

      // Cada motor da un paso por segundo de Binance, en el segundo + su retraso (igual en todos los servidores, no segun su reloj
      // interno). El tracker (rotacion del market, libro, archivo) se mueve justo antes del paso del motor A.
      for (const id of TIMED_IDS)
        stopEngines.push(
          scheduleEngine(
            engines3[id],
            () => clock.now(),
            (T) => {
              if (id === "a") tracker.tick(T);
              engines3[id].step(T, marketAt(T), engine.signals);
              if (id === "a") {
                const keep = new Set([tracker.current?.upToken ?? "", tracker.current?.downToken ?? "", tracker.next?.upToken ?? "", tracker.next?.downToken ?? ""]);
                feed.prune(T - 60_000, keep);
                fastRunner.books.prune(keep);
              }
            },
            () => ready,
          ),
        );
      stopEngines.push(scheduleFast(fastRunner, () => clock.now(), (t) => fastRunner.tick(t, marketAt(t)), () => ready));
      predict?.start();

      if (config.backfill) {
        const t0 = Date.now();
        const n = await backfillTrades(opts.restUrl, config.symbol, Date.now() - config.retentionMs - 60_000, ingest, opts.backfillPageDelayMs, tag("backfill"));
        console.log(`[${tag("backfill")}] ${n} trades in ${Date.now() - t0}ms; bars=${engine.bars.length} signals=${engine.signals.length}`);
      }
      pending.sort((a, b) => a.id - b.id).forEach(ingest);
      pending.length = 0;
      ready = true;
      console.log(`[${tag("server")}] ready`);
    },

    /** Backup final (antes de parar nada): copia consistente con todo en marcha (ADR 0013) */
    async finalBackup(): Promise<void> {
      await Promise.all([this.finalMainBackup(), predict?.finalBackup()]);
    },

    async finalMainBackup(): Promise<void> {
      if (!dbBackup || !bk?.enabled) return;
      try {
        marketStore.flush();
      } catch (e) {
        console.error(`[shutdown] ${tag("flush")}: ${e instanceof Error ? e.message : e}`);
      }
      console.log(`[${tag("backup")}] backup final antes de apagar…`);
      try {
        const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), bk.shutdownTimeoutMs));
        const r = await Promise.race([dbBackup.run(), timeout]);
        if (r === "timeout") console.error(`[${tag("backup")}] final sin terminar tras ${bk.shutdownTimeoutMs / 1000}s`);
        else console.log(`[${tag("backup")}] final ok: ${r.key} (${r.markets} markets)`);
      } catch (e) {
        console.error(`[${tag("backup")}] final fallo: ${e instanceof Error ? e.message : e}`);
      }
    },

    /** Para todo y cierra la base. Cada paso aislado: un fallo no impide los siguientes. */
    async stop(): Promise<void> {
      const step = (name: string, fn: () => void) => {
        try {
          fn();
        } catch (e) {
          console.error(`[shutdown] ${tag(name)}: ${e instanceof Error ? e.message : e}`);
        }
      };
      step("timers", () => timers.forEach((t) => clearInterval(t)));
      for (const stop of stopEngines) step("engine", stop);
      step("binance", () => upstream.stop());
      step("depth", () => depthClient.stop());
      await makerProbe.stop().catch(() => undefined);
      step("live", () => liveTrader.stop());
      step("tracker", () => tracker.stop());
      step("predict", () => predict?.stop());
      step("backup timer", () => dbBackup?.stop());
      step("db flush", () => marketStore.flush());
      step("db close", () => marketStore.close());
    },
  };
}
