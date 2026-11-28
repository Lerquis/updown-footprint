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
  type MarketAsset,
  type MarketSource,
  type OrderflowServerMessage,
  type PmDecision,
  type PmEngineId,
  type PmEngineInfo,
  type PmEngineThresholds,
  type PmMarketsResponse,
  type PmRecord,
  type PmRef,
  type PmRefPoint,
  type PmStrengthSet,
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
import { serverStrategy } from "./polymarket/serverStrategy.js";
import { PmBooks } from "./polymarket/pmBook.js";
import { DbBackup, type BackupConfig } from "./backup/backup.js";
import { PmFeed, scheduleEngine, TimedEngine } from "./polymarket/timedEngine.js";
import type { LatencyMonitor } from "./polymarket/latency.js";
import { LiveTrader } from "./polymarket/liveTrader.js";
import { MakerProbe } from "./polymarket/makerProbe.js";
import { detectStrengthSet, tokenMid, withRefMove } from "./polymarket/strength.js";
// [PREDICT desactivado] import type { PredictMarketApi } from "./predict/api.js";
// [PREDICT desactivado] import { createPredictVenue, type PredictVenue } from "./predict/venue.js";
// [PREDICT desactivado] import type { PredictWs } from "./predict/wsClient.js";
// [PREDICT desactivado] import type { PredictAccount } from "./predict/account.js";
// [PREDICT desactivado] import type { PredictLatencyMonitor } from "./predict/latency.js";

/** Lo que cambia entre activos (ADR 0018): simbolos y tamanos de precio/volumen; el resto de parametros es comun */
export interface AssetMarket {
  /** simbolo de Binance en minusculas (btcusdt) */
  symbol: string;
  /** simbolo de la API crypto-price de Polymarket (BTC) y prefijo de los slugs (btc-updown-5m) */
  pmSymbol: string;
  pmSlugPrefix: string;
  /** bucket de precio del heatmap y nivel del footprint (activo cotizado) */
  depthStep: number;
  footprintTick: number;
  /** volumen minimo (activo base) de un nivel para contar como desequilibrio */
  imbalanceMinVol: number;
  /** SS (movimientos con fuerza del motor C, docs/features/sol-strength.md): se calcula y se sirve con los markets */
  strength?: boolean;
}

/** Tokens Up/Down (1 s) del market de otra fuente (BTC) para compararlos con los de esta (SS). Lo expone cada fuente como `refFeed`. */
export interface RefFeed {
  /** activo (BTC) */
  label: string;
  /** tokens de 1 s en [start, end]: muestras del motor A del market de esa ventana (memoria o base); vacio si no esta */
  series(start: number, end: number): PmRefPoint[];
  /** cada muestra de 1 s nueva */
  onPoint(fn: (p: PmRefPoint) => void): void;
}

/** Como se conecta una fuente a Binance y donde guarda lo suyo */
export interface SourceOptions {
  id: MarketSource;
  asset: MarketAsset;
  market: AssetMarket;
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
  /** referencia para SS (la fuente BTC del mismo tipo); solo con `market.strength` */
  reference?: RefFeed;
  // [PREDICT desactivado] /** base de los markets de Predict de esta fuente y sus backups */
  // [PREDICT desactivado] predictDbPath: string;
  // [PREDICT desactivado] predictBackup: (BackupConfig & { enabled: boolean; restore: boolean; shutdownTimeoutMs: number }) | null;
}

/** Lo que comparten las dos fuentes: Polymarket es el mismo market para ambas; Predict, las mismas rondas y el mismo precio */
export interface SharedDeps {
  chainlink: ChainlinkClient | ChainlinkTwapClient;
  latencyMonitor: LatencyMonitor;
  // [PREDICT desactivado] /** null = sin motores de Predict (PREDICT_ENABLED o PREDICT_ENGINES en false) */
  // [PREDICT desactivado] predict: { api: PredictMarketApi; price: PredictWs; account: PredictAccount; latency: PredictLatencyMonitor } | null;
}

/**
 * Ruta HTTP/WS sin el activo ni la fuente (inversa de `sourcePath`): `/ws/eth/futures/x` -> eth + futures + `/ws/x`,
 * `/ws/futures/x` -> btc + futures, `/ws/eth/x` -> eth + spot; el resto es btc spot. Funcion pura.
 */
export function splitSource(pathname: string): { asset: MarketAsset; source: MarketSource; path: string } {
  const m = /^\/(ws|api)(\/eth)?(\/futures)?(\/.*)$/.exec(pathname);
  if (!m || (!m[2] && !m[3])) return { asset: "btc", source: "spot", path: pathname };
  return { asset: m[2] ? "eth" : "btc", source: m[3] ? "futures" : "spot", path: `/${m[1]}${m[4]}` };
}

/** Clave de una fuente en los mapas del servidor y prefijo de sus logs ("" = BTC spot, "futures", "eth", "eth-futures") */
export function sourceLabel(asset: MarketAsset, source: MarketSource): string {
  return [asset === "btc" ? null : asset, source === "spot" ? null : source].filter(Boolean).join("-");
}

const TIMED_IDS = ["a", "c"] as const;
type TimedId = (typeof TIMED_IDS)[number];
const ENGINE_IDS: PmEngineId[] = ["a", "c"];

export type Source = Awaited<ReturnType<typeof createSource>>;

/**
 * Una fuente completa (ADR 0016): Binance (trades, libro, orderflow, escenarios) -> motores A y C -> su base, sus backups,
 * sus compras reales y sus canales. Se crea una vez por fuente; nada de aqui se comparte entre fuentes salvo `shared`.
 * Llamar a `start()` cuando el servidor HTTP escuche.
 */
export async function createSource(opts: SourceOptions, shared: SharedDeps) {
  const { chainlink, latencyMonitor } = shared;
  const mk = opts.market;
  const SYMBOL = mk.symbol.toUpperCase();
  /** prefijo de los logs: BTC spot mantiene los de siempre ([binance]); el resto los marca ([futures:binance], [eth-futures:binance]) */
  const label = sourceLabel(opts.asset, opts.id);
  const tag = (name: string) => (label ? `${label}:${name}` : name);

  // ── Estado y motores ──
  const buffer = new TradeBuffer(config.retentionMs, config.tradesMax);
  const upstream = new AggTradeClient(opts.tradesWsUrl, mk.symbol, tag("binance"));

  const book = new OrderBook();
  const depthHistory = new DepthHistory(config.depthHistory);
  const depthClient = new DepthClient(opts.depthWsUrl, opts.restUrl, mk.symbol, book, opts.depthSnapshotLimit, opts.depthMode, tag("depth"));

  const engine = new OrderflowEngine({
    barMs: config.barMs,
    barHistory: config.barHistory,
    tick: mk.footprintTick,
    retentionMs: config.retentionMs,
    detector: {
      ...DEFAULT_DETECTOR,
      tick: mk.footprintTick,
      barMs: config.barMs,
      imbalanceRatio: config.imbalanceRatio,
      imbalanceMinVol: mk.imbalanceMinVol,
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
  const timedThresholds: PmEngineThresholds = { minEdge: strategy.minEdge, exitMargin: strategy.exitMargin, maxSpread: strategy.maxSpread, warmupS: strategy.warmupS, noEntryS: strategy.noEntryS };
  const engineInfo: PmEngineInfo[] = [
    ...TIMED_IDS.map((id) => ({ id, mode: id === "a" ? ("live" as const) : ("asOf" as const), delayMs: config.pmEngineDelayMs[id], thresholds: timedThresholds })),
  ];
  /** Parametros con los que se genera cada market guardado (para reproducirlo) */
  const engineParams = {
    source: opts.id,
    asset: opts.asset,
    strategy,
    engines: engineInfo,
    detector: { tick: mk.footprintTick, barMs: config.barMs, imbalanceRatio: config.imbalanceRatio, imbalanceMinVol: mk.imbalanceMinVol, imbalanceMinStack: config.imbalanceMinStack },
    depth: { step: mk.depthStep, rangePct: config.depthRangePct, intervalMs: config.depthIntervalMs },
  };
  const tracker = new PolymarketTracker(
    new HttpPolymarketApi(config.pmGammaUrl, config.pmSiteUrl, mk.pmSymbol, config.pmVariant, config.pmMarketMs, config.pmTwapSeconds),
    { bars: () => engine.allBars(), cvd: () => engine.cvdPoints, signals: () => engine.signals },
    (tokens) => new BookClient(config.pmBookWsUrl, tokens),
    {
      marketMs: config.pmMarketMs,
      slugPrefix: mk.pmSlugPrefix,
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
  // Libro L2 de los tokens de Polymarket (lo usa el check maker)
  const books = new PmBooks();
  /** Registro de decisiones de un motor */
  const engineTrack = (id: PmEngineId): { slug: string | null; decisions: PmDecision[] } => ({ slug: engines3[id].slug, decisions: engines3[id].decisions.slice() });
  console.log(`[${tag("polymarket")}] db ${opts.dbPath}: ${marketStore.count()} markets completos guardados, ${marketStore.counts().trades} aggTrades, ${tracker.history.length} cargados`);

  // Los mismos motores sobre las rondas de Predict.fun (precio puntual, sin TWAP), con el flujo de esta fuente
  let ready = false;
  // Predict esta comentado entero (no se crea, no consume nada). Para reactivarlo, quitar los "// [PREDICT desactivado]".
  // [PREDICT desactivado] const predict: PredictVenue | null = shared.predict
    // [PREDICT desactivado] ? await createPredictVenue({
        // [PREDICT desactivado] source: opts.id,
        // [PREDICT desactivado] tag,
        // [PREDICT desactivado] clock,
        // [PREDICT desactivado] flow: { bars: () => engine.allBars(), cvd: () => engine.cvdPoints, signals: () => engine.signals },
        // [PREDICT desactivado] signals: () => engine.signals,
        // [PREDICT desactivado] api: shared.predict.api,
        // [PREDICT desactivado] price: shared.predict.price,
        // [PREDICT desactivado] account: shared.predict.account,
        // [PREDICT desactivado] latency: shared.predict.latency,
        // [PREDICT desactivado] dbPath: opts.predictDbPath,
        // [PREDICT desactivado] backup: opts.predictBackup,
        // [PREDICT desactivado] coverage: (from, to) => marketStore.tradeCoverage(from, to).ok,
        // [PREDICT desactivado] symbol: SYMBOL,
        // [PREDICT desactivado] isReady: () => ready,
      // [PREDICT desactivado] })
    // [PREDICT desactivado] : null;

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
    step: mk.depthStep,
    retentionMs: config.retentionMs,
    columns: depthHistory.snapshot(),
    upstream: depthClient.state,
  }));
  const orderflow = new Channel<OrderflowServerMessage>(() => ({
    type: "snapshot",
    symbol: SYMBOL,
    tick: mk.footprintTick,
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
  // ── SS (docs/features/sol-strength.md): se calcula al servir cada market a partir de las muestras del motor C; no se guarda ──
  const ref = mk.strength ? opts.reference : undefined;
  const refOf = (start: number, end: number): PmRef | undefined => (ref ? { label: ref.label, points: ref.series(start, end) } : undefined);
  const strengthOf = (points: PmRecord["points"], start: number, r: PmRef | undefined): PmStrengthSet => {
    const set = detectStrengthSet(points, start);
    return r ? { sol: withRefMove(set.sol, r.points), base: withRefMove(set.base, r.points) } : set;
  };
  const ssCache = new Map<string, { key: string; extra: Pick<PmRecord, "strength" | "ref"> }>();
  /** el market con su SS y su referencia (copia; el record del tracker no cambia: es el que se guarda) */
  const withStrength = (rec: PmRecord): PmRecord => {
    if (!mk.strength) return rec;
    const c = rec.engines?.c?.points ?? [];
    const key = `${c.length}`;
    let hit = ssCache.get(rec.market.slug);
    if (!hit || hit.key !== key) {
      const r = refOf(rec.market.start, rec.market.end);
      hit = { key, extra: { strength: strengthOf(c, rec.market.start, r), ...(r ? { ref: r } : {}) } };
      // sin referencia todavia (p. ej. BTC aun no guardo ese tramo) no se cachea: se reintenta la proxima vez
      if (!r || r.points.length) ssCache.set(rec.market.slug, hit);
      if (ssCache.size > 300) ssCache.delete(ssCache.keys().next().value!);
    }
    return { ...rec, ...hit.extra };
  };
  const liveStrength = (): PmStrengthSet => {
    const cur = tracker.current;
    return cur ? strengthOf(tracker.live("c").points, cur.start, refOf(cur.start, cur.end)) : { sol: [], base: [] };
  };
  let lastStrength = "";

  const polymarket = new Channel<PolymarketServerMessage>(() => ({
    type: "snapshot",
    current: tracker.current,
    next: tracker.next,
    points: tracker.points.slice(),
    trades: tracker.trades.slice(),
    engines: {
      c: { points: tracker.live("c").points.slice(), trades: tracker.live("c").trades.slice() },
    },
    history: tracker.history.map(withStrength),
    historyMax: config.pmHistory,
    upstream: pmUpstream(),
    ...(mk.strength && tracker.current ? { strength: liveStrength(), ref: refOf(tracker.current.start, tracker.current.end) } : {}),
  }));

  const engines = new Channel<EnginesServerMessage>(() => ({
    type: "snapshot",
    thresholds: timedThresholds,
    engines: engineInfo,
    decisions: Object.fromEntries(ENGINE_IDS.map((id) => [id, engineTrack(id)])) as Record<PmEngineId, { slug: string | null; decisions: PmDecision[] }>,
  }));

  // Compras reales siguiendo al motor A o C DE ESTA FUENTE: solo con su interruptor activado y solo en el market en curso.
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

  // Check maker: ordenes maker reales siguiendo al motor A o C de esta fuente, solo con el interruptor
  const makerProbe = new MakerProbe(config.makerProbe, {
    trader: liveTrader,
    quote: (token) => {
      const b = books.has(token) ? books.get(token) : null;
      const q = b && b.time > 0 ? { bid: b.bestBid(), ask: b.bestAsk() } : feed.quote(token, Infinity);
      return { bid: q?.bid ?? null, ask: q?.ask ?? null };
    },
    levelSize: (token, side, price) => (books.has(token) ? books.get(token).sizeAt(side, price) : 0),
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
    // [PREDICT desactivado] predict?.addTrade(t);
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
  // libro L2 de Polymarket -> check maker
  tracker.on("book", (b) => books.get(b.token).snapshot(b.bids, b.asks, b.time ?? clock.now()));
  tracker.on("level", (l) => {
    books.get(l.token).set(l.side, l.price, l.size, l.time ?? clock.now());
    makerProbe.onLevel(l.token, l.side, l.price, l.size);
  });
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
  const pmStatus = () => polymarket.broadcast({ type: "status", upstream: pmUpstream() });
  tracker.on("status", pmStatus);
  chainlink.on("state", pmStatus);
  tracker.on("markets", (current, next) => {
    liveTrader.onMarket(current);
    makerProbe.onMarket(current);
    if (ready) polymarket.broadcast({ type: "markets", current, next });
  });
  tracker.on("point", (engine, point) => {
    if (!ready) return;
    polymarket.broadcast({ type: "point", engine, point });
    // SS del market en curso: se recalcula con cada muestra del motor C y se envia solo si cambia
    if (mk.strength && engine === "c" && tracker.current) {
      const strength = liveStrength();
      const key = `${tracker.current.slug}:${JSON.stringify(strength)}`;
      if (key !== lastStrength) {
        lastStrength = key;
        polymarket.broadcast({ type: "strength", slug: tracker.current.slug, strength });
      }
    }
  });
  ref?.onPoint((point) => {
    const cur = tracker.current;
    if (ready && cur && point.time >= cur.start && point.time <= cur.end) polymarket.broadcast({ type: "ref", slug: cur.slug, label: ref.label, point });
  });
  tracker.on("signal", (engine, signal) => ready && polymarket.broadcast({ type: "signal", engine, signal }));
  tracker.on("record", (record) => {
    if (ready) polymarket.broadcast({ type: "record", record: withStrength(record) });
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
    // [PREDICT desactivado] ...(predict?.channels ?? []),
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

  /** tokens Up/Down de 1 s de los markets de esta fuente, para SS de otro activo (docs/features/sol-strength.md) */
  const toRef = (p: PmRecord["points"][number]): PmRefPoint => ({ time: p.time, up: tokenMid(p.upBid, p.upAsk), down: tokenMid(p.downBid, p.downAsk) });
  const refFeed: RefFeed = {
    label: opts.asset.toUpperCase(),
    series(start, end) {
      const fromPoints = (pts: PmRecord["points"]) => pts.filter((p) => p.time >= start && p.time <= end).map(toRef);
      if (tracker.current?.start === start) return fromPoints(tracker.points);
      const rec = tracker.history.find((r) => r.market.start === start) ?? marketStore.get(`${mk.pmSlugPrefix}-${Math.round(start / 1000)}`);
      return rec ? fromPoints(rec.points) : [];
    },
    onPoint(fn) {
      tracker.on("point", (engine, p) => {
        if (engine === "a") fn(toRef(p));
      });
    },
  };

  return {
    id: opts.id,
    asset: opts.asset,
    marketStore,
    refFeed,
    clock,
    tracker,
    // [PREDICT desactivado] /** motores de Predict de esta fuente (null si estan desactivados) */
    // [PREDICT desactivado] predict,
    channels,
    get ready() {
      return ready;
    },

    /**
     * API HTTP de la fuente. `path` va sin el prefijo de la fuente (`/api/markets`). Devuelve false si la ruta no es suya.
     */
    handleHttp(req: IncomingMessage, res: ServerResponse, path: string, url: URL): boolean {
      // [PREDICT desactivado] if (predict?.handleHttp(req, res, path, url)) return true;
      // Interruptor de compras reales (motor A o C de esta fuente, market en curso). Protegido con TRADING_PASSWORD.
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
        res.end(JSON.stringify(withStrength(rec)));
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
        },
        // [PREDICT desactivado] predict: predict ? predict.health() : { enabled: false },
        predict: { enabled: false },
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
          const col = book.toColumn(mk.depthStep, config.depthRangePct, depthClient.lastEventTime);
          if (!col) return;
          depthHistory.push(col);
          marketStore.addDepth(col, mk.depthStep);
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
                books.prune(keep);
              }
            },
            () => ready,
          ),
        );
      // [PREDICT desactivado] predict?.start();

      if (config.backfill) {
        const t0 = Date.now();
        const n = await backfillTrades(opts.restUrl, mk.symbol, Date.now() - config.retentionMs - 60_000, ingest, opts.backfillPageDelayMs, tag("backfill"));
        console.log(`[${tag("backfill")}] ${n} trades in ${Date.now() - t0}ms; bars=${engine.bars.length} signals=${engine.signals.length}`);
      }
      pending.sort((a, b) => a.id - b.id).forEach(ingest);
      pending.length = 0;
      ready = true;
      console.log(`[${tag("server")}] ready`);
    },

    /** Backup final (antes de parar nada): copia consistente con todo en marcha (ADR 0013) */
    async finalBackup(): Promise<void> {
      // [PREDICT desactivado] await Promise.all([this.finalMainBackup(), predict?.finalBackup()]);
      await this.finalMainBackup();
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
      // [PREDICT desactivado] step("predict", () => predict?.stop());
      step("backup timer", () => dbBackup?.stop());
      step("db flush", () => marketStore.flush());
      step("db close", () => marketStore.close());
    },
  };
}
