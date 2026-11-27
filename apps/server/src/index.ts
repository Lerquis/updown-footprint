import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  CHANNELS,
  type AggTrade,
  type AggTradesServerMessage,
  type AnalysisServerMessage,
  type DepthServerMessage,
  type EnginesServerMessage,
  type LatencyServerMessage,
  type OrderflowServerMessage,
  type PmEngineId,
  type PmMarketsResponse,
  type PolymarketServerMessage,
  type UpstreamState,
} from "@updown/protocol";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { AggTradeClient } from "./binance/aggTradeClient.js";
import { backfillTrades } from "./binance/backfill.js";
import { DepthClient } from "./binance/depthClient.js";
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
import { ChainlinkClient } from "./polymarket/chainlinkClient.js";
import { ChainlinkTwapClient } from "./polymarket/chainlinkTwapClient.js";
import { PolymarketTracker } from "./polymarket/tracker.js";
import { ENGINE_VERSION, MarketStore } from "./polymarket/store.js";
import { DEFAULT_MODEL } from "./polymarket/model.js";
import { DEFAULT_STRATEGY } from "./polymarket/strategy.js";
import { DbBackup } from "./backup/backup.js";
import { PmFeed, scheduleEngine, TimedEngine } from "./polymarket/timedEngine.js";
import { slotStart } from "./polymarket/tracker.js";
import { LatencyMonitor } from "./polymarket/latency.js";

const SYMBOL = config.symbol.toUpperCase();

// ── Estado y motores ──
const buffer = new TradeBuffer(config.retentionMs, config.tradesMax);
const upstream = new AggTradeClient(config.binanceWsUrl, config.symbol);

const book = new OrderBook();
const depthHistory = new DepthHistory(config.depthHistory);
const depthClient = new DepthClient(config.binanceWsUrl, config.binanceRestUrl, config.symbol, book, config.depthSnapshotLimit);

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

const clock = new ExchangeClock();
// Precio de referencia: TWAP de Chainlink (PolyBolt, necesita credenciales CLOB) o, si faltan, el spot del RTDS antiguo.
const hasClob = Boolean(config.pmClob.apiKey && config.pmClob.secret && config.pmClob.passphrase);
const chainlink: ChainlinkClient | ChainlinkTwapClient = hasClob
  ? new ChainlinkTwapClient(config.pmTwapWsUrl, config.pmClob)
  : new ChainlinkClient(config.pmLiveWsUrl);
console.log(`[polymarket] price feed: ${hasClob ? "Chainlink TWAP 60s (PolyBolt)" : "Chainlink spot (RTDS, sin credenciales)"}`);
// Backups a S3/R2 (solo si hay bucket configurado). Con PM_DB_RESTORE y sin base local, se descarga la ultima copia antes de abrirla.
const bk = config.backup;
const dbBackup = bk.s3.bucket && bk.s3.endpoint && bk.s3.accessKeyId && bk.s3.secretAccessKey ? new DbBackup(bk, config.pmDbPath) : null;
if (dbBackup && bk.restore) await dbBackup.restoreIfMissing();
const marketStore = new MarketStore(config.pmDbPath, SYMBOL);
/** true si la carpeta de la base es otro sistema de archivos que la raiz (un volumen montado); en Railway debe serlo */
const dbOnVolume = (() => {
  try {
    return statSync(dirname(config.pmDbPath)).dev !== statSync("/").dev;
  } catch {
    return false;
  }
})();
if (process.env.RAILWAY_ENVIRONMENT && !dbOnVolume)
  console.error(`[db] !!! ${dirname(config.pmDbPath)} NO es un volumen: la base se borrara en el proximo deploy. Solo quedaran los backups de R2.`);
const dbInfo = () => {
  let sizeMb: number | null = null;
  try {
    sizeMb = Math.round((statSync(config.pmDbPath).size / 1048576) * 10) / 10;
  } catch {}
  return {
    path: config.pmDbPath,
    sizeMb,
    onVolume: dbOnVolume,
    backup: dbBackup
      ? { enabled: bk.enabled, intervalH: bk.intervalMs / 3600_000, keepH: bk.keepHours, last: dbBackup.lastBackup() ? new Date(dbBackup.lastBackup()).toISOString() : null }
      : null,
  };
};
if (dbBackup && bk.enabled) dbBackup.start();
// La base de la generacion anterior (si existe) se sube una vez al archivo del bucket; nunca se borra ni se modifica
if (dbBackup)
  void dbBackup
    .archiveOnce(config.pmLegacyDbPath, process.env.RAILWAY_ENVIRONMENT ? "railway" : "local")
    .catch((e) => console.error(`[backup] no se pudo archivar la base anterior: ${e instanceof Error ? e.message : e}`));
const strategy = {
  ...DEFAULT_STRATEGY,
  model: { ...DEFAULT_MODEL, modelWeight: config.pmModelWeight, flowGain: config.pmFlowGain, twapSeconds: config.pmTwapSeconds },
  feeRate: config.pmFeeRate,
  slippage: config.pmSlippage,
  minEdge: config.pmMinEdge,
  exitMargin: config.pmExitMargin,
  bankroll: config.pmBankroll,
  kellyFraction: config.pmKellyFraction,
  maxStakePct: config.pmMaxStakePct,
  maxMarketPct: config.pmMaxMarketPct,
  warmupS: config.pmWarmupS,
  noEntryS: config.pmNoEntryS,
};
const ENGINE_IDS: PmEngineId[] = ["a", "b", "c"];
const engineInfo = ENGINE_IDS.map((id) => ({ id, mode: id === "a" ? ("live" as const) : ("asOf" as const), delayMs: config.pmEngineDelayMs[id] }));
/** Parametros con los que se genera cada market guardado (para reproducirlo) */
const engineParams = {
  strategy,
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
// Motores A, B y C: mismas reglas; deciden cada segundo de Binance (+ su retraso). A con lo ultimo recibido, B y C "a fecha".
const feed = new PmFeed();
const engines3 = Object.fromEntries(
  engineInfo.map((e) => [e.id, new TimedEngine({ ...e, strategy, retentionMs: config.retentionMs, decisionsMax: Math.ceil(config.pmMarketMs / 1000) + 10 }, feed)]),
) as Record<PmEngineId, TimedEngine>;
console.log(`[polymarket] db ${config.pmDbPath}: ${marketStore.count()} markets completos guardados, ${marketStore.counts().trades} aggTrades, ${tracker.history.length} cargados`);

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
    b: { points: tracker.live("b").points.slice(), trades: tracker.live("b").trades.slice() },
    c: { points: tracker.live("c").points.slice(), trades: tracker.live("c").trades.slice() },
  },
  history: tracker.history.slice(),
  historyMax: config.pmHistory,
  upstream: pmUpstream(),
}));

const engines = new Channel<EnginesServerMessage>(() => ({
  type: "snapshot",
  thresholds: { minEdge: strategy.minEdge, exitMargin: strategy.exitMargin, maxSpread: strategy.maxSpread, warmupS: strategy.warmupS, noEntryS: strategy.noEntryS },
  engines: engineInfo,
  decisions: Object.fromEntries(ENGINE_IDS.map((id) => [id, { slug: engines3[id].slug, decisions: engines3[id].decisions.slice() }])) as Record<
    PmEngineId,
    { slug: string | null; decisions: import("@updown/protocol").PmDecision[] }
  >,
}));

// Latencia hacia el CLOB de Polymarket cada 15 s (solo lectura: nunca opera). Libro del token Up del market en curso.
const latencyMonitor = new LatencyMonitor(
  {
    clobUrl: config.pmClobUrl,
    creds: { ...config.pmClob, address: config.pmSignerAddress, funder: config.pmFunderAddress },
    intervalMs: config.pmLatencyIntervalMs,
    keepAliveMs: config.pmLatencyKeepAliveMs,
    historyMax: config.pmLatencyHistory,
  },
  () => tracker.current?.upToken ?? tracker.next?.upToken ?? null,
  () => clock.now(),
);
if (!latencyMonitor.authReady) console.log("[latency] sin PM_SIGNER_ADDRESS o credenciales CLOB: la medida autenticada respondera 401 (la latencia del gateway sigue siendo valida)");
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
}));
latencyMonitor.on("sample", (sample) => latency.broadcast({ type: "sample", sample }));
latencyMonitor.on("state", (upstream) => latency.broadcast({ type: "status", upstream }));

// ── Tuberia de trades: relleno historico + vivo, sin duplicados ──
let ready = false;
let lastId = 0;
const pending: AggTrade[] = [];

const ingest = (t: AggTrade) => {
  if (t.id <= lastId) return; // ya procesado (solape relleno/vivo)
  lastId = t.id;
  buffer.push(t);
  marketStore.addTrade(t);
  engine.ingest(t);
  for (const id of ENGINE_IDS) engines3[id].addTrade(t);
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
for (const id of ENGINE_IDS) {
  engines3[id].on("step", (st) => {
    tracker.addStep(id, st.slug, st.point, st.signals);
    engines.broadcast({ type: "decision", engine: id, slug: st.slug, decision: st.decision });
  });
}
const pmStatus = () => polymarket.broadcast({ type: "status", upstream: pmUpstream() });
tracker.on("status", pmStatus);
chainlink.on("state", pmStatus);
tracker.on("markets", (current, next) => ready && polymarket.broadcast({ type: "markets", current, next }));
tracker.on("point", (engine, point) => ready && polymarket.broadcast({ type: "point", engine, point }));
tracker.on("signal", (engine, signal) => ready && polymarket.broadcast({ type: "signal", engine, signal }));
tracker.on("record", (record) => {
  if (ready) polymarket.broadcast({ type: "record", record });
  // solo se guardan markets resueltos y con los 5 minutos completos (se reintenta al llegar el resultado)
  if (record.market.status === "closed" && record.complete && marketStore.save(record, { version: ENGINE_VERSION, params: engineParams })) {
    console.log(`[polymarket] guardado ${record.market.slug} (${record.market.result}, pnl ${record.pnl.net})`);
  } else if (record.market.status === "closed" && !record.complete) {
    console.log(`[polymarket] ${record.market.slug} incompleto: no se guarda`);
  }
});

engine.on("bar", (bar) => ready && orderflow.broadcast({ type: "bar", bar }));
engine.on("cvd", (point) => ready && orderflow.broadcast({ type: "cvd", point }));
engine.on("signal", (signal) => ready && orderflow.broadcast({ type: "signal", signal }));

// ── Muestreos periodicos ──
const depthSampler = setInterval(() => {
  if (depthClient.state !== "connected" || !depthClient.lastEventTime) return;
  const col = book.toColumn(config.depthStep, config.depthRangePct, depthClient.lastEventTime);
  if (!col) return;
  depthHistory.push(col);
  marketStore.addDepth(col, config.depthStep);
  depth.broadcast({ type: "column", column: col });
}, config.depthIntervalMs);

const flowSampler = setInterval(() => {
  marketStore.flush();
  if (!ready) return;
  engine.tick();
  const r = monitor.update();
  if (!r) return;
  analysis.broadcast({ type: "summary", summary: r.summary });
  if (r.changed) analysis.broadcast({ type: "change", summary: r.summary });
}, 1000);

// Cada motor da un paso por segundo de Binance, en el segundo + su retraso (igual en todos los servidores, no segun su reloj
// interno). El tracker (rotacion del market, libro, archivo) se mueve justo antes del paso del motor A.
const marketAt = (T: number) => {
  const slot = slotStart(T, config.pmMarketMs);
  return tracker.current?.start === slot ? tracker.current : tracker.next?.start === slot ? tracker.next : null;
};
const stopEngines = ENGINE_IDS.map((id) =>
  scheduleEngine(
    engines3[id],
    () => clock.now(),
    (T) => {
      if (id === "a") tracker.tick(T);
      engines3[id].step(T, marketAt(T), engine.signals);
      if (id === "a") feed.prune(T - 60_000, new Set([tracker.current?.upToken ?? "", tracker.current?.downToken ?? "", tracker.next?.upToken ?? "", tracker.next?.downToken ?? ""]));
    },
    () => ready,
  ),
);

// ── HTTP + WS ──
const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        ready,
        upstream: upstream.state,
        memory: { trades: buffer.size, depthColumns: depthHistory.size, bars: engine.bars.length, cvdPoints: engine.cvdPoints.length, signals: engine.signals.length },
        clients: { aggTrades: aggTrades.size, depth: depth.size, orderflow: orderflow.size, analysis: analysis.size, polymarket: polymarket.size, engines: engines.size, latency: latency.size },
        polymarket: { upstream: pmUpstream(), chainlink: chainlink.state, current: tracker.current?.slug ?? null, history: tracker.history.length, saved: marketStore.count(), engines: Object.fromEntries(ENGINE_IDS.map((id) => [id, { market: engines3[id].slug, decisions: engines3[id].decisions.length, delayMs: config.pmEngineDelayMs[id] }])) },
        depth: { upstream: depthClient.state },
        db: dbInfo(),
        latency: { region: config.region, authReady: latencyMonitor.authReady, reconnects: latencyMonitor.reconnects, last: latencyMonitor.history.at(-1) ?? null },
      }),
    );
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/markets" && req.method === "GET") {
    // resumen de todos los markets guardados (sin points/barras): ?limit=&from=&to=&order=asc|desc
    const q = url.searchParams;
    const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
    const body: PmMarketsResponse = {
      total: marketStore.count(),
      markets: marketStore.list({ from: num("from"), to: num("to"), limit: num("limit"), order: q.get("order") === "asc" ? "asc" : "desc" }),
    };
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": config.allowedOrigin || "*" });
    res.end(JSON.stringify(body));
    return;
  }
  const one = /^\/api\/markets\/([\w-]+)$/.exec(url.pathname);
  if (one && req.method === "GET") {
    // un market guardado completo (para abrirlo en el grafico)
    const rec = marketStore.get(one[1]!);
    if (!rec) return void res.writeHead(404, { "access-control-allow-origin": config.allowedOrigin || "*" }).end();
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": config.allowedOrigin || "*" });
    res.end(JSON.stringify(rec));
    return;
  }
  res.writeHead(404).end();
});

// Un WebSocketServer por canal; el enrutado por path se hace en `upgrade`.
// perMessageDeflate solo para mensajes grandes (snapshots); los deltas pequenos no se comprimen.
const routes = new Map<string, WebSocketServer>();
function mount<M>(path: string, channel: Channel<M>) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
  wss.on("connection", (ws) => channel.add(ws));
  routes.set(path, wss);
}
mount(CHANNELS.aggTrades, aggTrades);
mount(CHANNELS.depth, depth);
mount(CHANNELS.orderflow, orderflow);
mount(CHANNELS.analysis, analysis);
mount(CHANNELS.polymarket, polymarket);
mount(CHANNELS.engines, engines);
mount(CHANNELS.latency, latency);

http.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (config.allowedOrigin && origin !== config.allowedOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const wss = routes.get(pathname);
  if (!wss) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

http.listen(config.port, async () => {
  console.log(`[server] http/ws on :${config.port} (${[...routes.keys()].join(", ")}, /health)`);
  upstream.start();
  depthClient.start();
  chainlink.start();
  latencyMonitor.start();

  if (config.backfill) {
    const t0 = Date.now();
    const n = await backfillTrades(config.binanceRestUrl, config.symbol, Date.now() - config.retentionMs - 60_000, ingest);
    console.log(`[backfill] ${n} trades in ${Date.now() - t0}ms; bars=${engine.bars.length} signals=${engine.signals.length}`);
  }
  pending.sort((a, b) => a.id - b.id).forEach(ingest);
  pending.length = 0;
  ready = true;
  console.log("[server] ready");
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(depthSampler);
  clearInterval(flowSampler);
  for (const stop of stopEngines) stop();
  upstream.stop();
  depthClient.stop();
  chainlink.stop();
  latencyMonitor.stop();
  tracker.stop();
  dbBackup?.stop();
  marketStore.flush();
  // backup final antes de cada deploy/reinicio: si el volumen se pierde, R2 tiene la base hasta este instante (ADR 0013)
  if (dbBackup && bk.enabled) {
    console.log("[backup] backup final antes de apagar…");
    const timeout = new Promise<void>((r) => setTimeout(r, bk.shutdownTimeoutMs).unref());
    await Promise.race([
      dbBackup.run().then(
        (r) => console.log(`[backup] final ok: ${r.key} (${r.markets} markets)`),
        (e) => console.error(`[backup] final fallo: ${e instanceof Error ? e.message : e}`),
      ),
      timeout.then(() => console.error(`[backup] final sin terminar tras ${bk.shutdownTimeoutMs / 1000}s`)),
    ]);
  }
  marketStore.close();
  http.close(() => process.exit(0));
  // los WS abiertos mantienen vivo el servidor HTTP: la base ya esta cerrada, salir igualmente
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
