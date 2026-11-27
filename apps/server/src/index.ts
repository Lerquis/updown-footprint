import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { sourcePath, type CompareMarketRow, type CompareResponse, type MarketSource } from "@updown/protocol";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { ChainlinkClient } from "./polymarket/chainlinkClient.js";
import { ChainlinkTwapClient } from "./polymarket/chainlinkTwapClient.js";
import { LatencyMonitor } from "./polymarket/latency.js";
import { compareMarkets, compareTotals } from "./polymarket/compare.js";
import { serverFast } from "./polymarket/serverStrategy.js";
import { createSource, splitSource, type Source } from "./source.js";
import { PredictMarketApi } from "./predict/api.js";
import { PredictWs } from "./predict/wsClient.js";
import { PredictAccount } from "./predict/account.js";
import { PredictLatencyMonitor } from "./predict/latency.js";
import { parseToken } from "./predict/model.js";

/**
 * Composicion (ADR 0016): lo compartido (Chainlink, latencia al CLOB) + una fuente completa por mercado de Binance
 * (spot siempre; futures si FUTURES_ENABLED). Cada fuente tiene sus canales (`/ws/...` y `/ws/futures/...`), su API, su base,
 * sus backups y sus compras reales. Aqui solo se enruta.
 */

// ── Compartido ──
// Precio de referencia: TWAP de Chainlink (PolyBolt, necesita credenciales CLOB) o, si faltan, el spot del RTDS antiguo.
const hasClob = Boolean(config.pmClob.apiKey && config.pmClob.secret && config.pmClob.passphrase);
const chainlink: ChainlinkClient | ChainlinkTwapClient = hasClob ? new ChainlinkTwapClient(config.pmTwapWsUrl, config.pmClob) : new ChainlinkClient(config.pmLiveWsUrl);
console.log(`[polymarket] price feed: ${hasClob ? "Chainlink TWAP 60s (PolyBolt)" : "Chainlink spot (RTDS, sin credenciales)"}`);
const fast = serverFast();
if (fast.calibration) console.log(`[fast] deriva calibrada (${fast.calibration.createdAt}, ${fast.calibration.samples} muestras): ${fast.calibration.betas.join(", ")}`);

// Latencia hacia el CLOB de Polymarket cada 15 s (solo lectura: nunca opera). Libro del token Up del market en curso (el de spot).
let latencyToken: () => string | null = () => null;
let latencyClock: () => number = () => Date.now();
const latencyMonitor = new LatencyMonitor(
  {
    clobUrl: config.pmClobUrl,
    creds: { ...config.pmClob, address: config.pmSignerAddress, funder: config.pmFunderAddress },
    intervalMs: config.pmLatencyIntervalMs,
    keepAliveMs: config.pmLatencyKeepAliveMs,
    historyMax: config.pmLatencyHistory,
  },
  () => latencyToken(),
  () => latencyClock(),
);
if (!latencyMonitor.authReady) console.log("[latency] sin PM_SIGNER_ADDRESS o credenciales CLOB: la medida autenticada respondera 401 (la latencia del gateway sigue siendo valida)");

// ── Fuentes ──
const bk = config.backup;
const backupFor = (prefix: string) => ({ ...bk, prefix });
// Predict.fun (ADR 0017): rondas por REST y precio Chainlink PUNTUAL por su WS, compartidos por las fuentes; cada fuente monta
// sus propios motores sobre ellos (predict/venue.ts)
const pc = config.predict;
// La cuenta (compras reales) y la latencia a su API tambien son comunes: cada fuente tiene su interruptor pero opera con la misma cuenta
let predictClock: () => number = () => Date.now();
let predictMarket: () => { marketId: number; upTokenId: string | null; feeRateBps: number } | null = () => null;
const predictShared = (() => {
  if (!pc.enabled || !pc.engines) return null;
  const api = new PredictMarketApi({ restUrl: pc.restUrl, apiKey: pc.apiKey, series: pc.series });
  const account = new PredictAccount({ restUrl: pc.restUrl, wsUrl: pc.wsUrl, apiKey: pc.apiKey, privateKey: pc.live.privateKey, predictAccount: pc.live.account });
  const latency = new PredictLatencyMonitor(
    { restUrl: pc.restUrl, apiKey: pc.apiKey, intervalMs: pc.latencyIntervalMs, historyMax: config.pmLatencyHistory },
    account,
    () => predictMarket(),
    () => predictClock(),
  );
  return { api, price: new PredictWs("predict-price", pc.wsUrl, pc.priceFeedId), account, latency };
})();
if (!predictShared) console.log("[predict] desactivado (PREDICT_ENABLED / PREDICT_ENGINES)");
const shared = { chainlink, latencyMonitor, predict: predictShared };
const spot = await createSource(
  {
    id: "spot",
    tradesWsUrl: config.binanceWsUrl,
    depthWsUrl: config.binanceWsUrl,
    restUrl: config.binanceRestUrl,
    depthMode: "spot",
    depthSnapshotLimit: config.depthSnapshotLimit,
    backfillPageDelayMs: 60,
    dbPath: config.pmDbPath,
    legacyDbPath: config.pmLegacyDbPath,
    backup: backupFor(bk.prefix),
    predictDbPath: pc.dbPath,
    predictBackup: backupFor(pc.backupPrefix),
  },
  shared,
);
const fc = config.futures;
const futures = fc.enabled
  ? await createSource(
      {
        id: "futures",
        tradesWsUrl: fc.tradesWsUrl,
        depthWsUrl: fc.depthWsUrl,
        restUrl: fc.restUrl,
        depthMode: "futures",
        depthSnapshotLimit: fc.depthSnapshotLimit,
        backfillPageDelayMs: fc.backfillPageDelayMs,
        dbPath: fc.dbPath,
        legacyDbPath: null,
        backup: backupFor(fc.backupPrefix),
        predictDbPath: pc.futuresDbPath,
        predictBackup: backupFor(pc.futuresBackupPrefix),
      },
      shared,
    )
  : null;
if (!futures) console.log("[futures] desactivado (FUTURES_ENABLED=false)");
const sources = new Map<MarketSource, Source>([["spot", spot], ...(futures ? ([["futures", futures]] as const) : [])]);
latencyToken = () => spot.tracker.current?.upToken ?? spot.tracker.next?.upToken ?? null;

// ── Comparativa spot vs futures (GET /api/compare) ──
/** filas ya calculadas de markets con el resultado de las dos fuentes (no cambian): no se vuelve a leer su JSON */
const compareCache = new Map<string, CompareMarketRow>();
function compare(limit: number): CompareResponse {
  if (!futures) return { markets: [], totals: compareTotals([]), futuresEnabled: false };
  const rows: CompareMarketRow[] = [];
  for (const { slug } of futures.marketStore.list({ limit })) {
    const cached = compareCache.get(slug);
    if (cached) {
      rows.push(cached);
      continue;
    }
    const s = spot.marketStore.get(slug);
    const f = futures.marketStore.get(slug);
    if (!s || !f) continue;
    const [row] = compareMarkets([s], [f]);
    if (!row) continue;
    rows.push(row);
    if (s.pnl.net !== null && f.pnl.net !== null) compareCache.set(slug, row);
  }
  rows.sort((a, b) => b.start - a.start);
  return { markets: rows, totals: compareTotals(rows), futuresEnabled: true };
}

// ── HTTP ──
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const cors = { "access-control-allow-origin": config.allowedOrigin || "*" };
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        // spot en la raiz (como siempre); futures en su propia seccion
        ...spot.health(),
        futures: futures ? futures.health() : { enabled: false },
        latency: { region: config.region, authReady: latencyMonitor.authReady, reconnects: latencyMonitor.reconnects, last: latencyMonitor.history.at(-1) ?? null },
      }),
    );
    return;
  }
  if (url.pathname === "/api/compare" && req.method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 96));
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(compare(limit)));
    return;
  }
  if (url.pathname === "/api/replays" && req.method === "GET") {
    // informe de replays del motor A con ejecucion retrasada (lo genera `npm run replays`; ver docs/features/replays.md). Solo spot.
    const file = join(config.replayDir, "report.json");
    if (!existsSync(file)) {
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Sin informe: ejecutar `npm run replays -w @updown/server` en este servidor" }));
      return;
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    createReadStream(file).pipe(res);
    return;
  }
  const { source, path } = splitSource(url.pathname);
  const src = sources.get(source);
  if (src?.handleHttp(req, res, path, url)) return;
  res.writeHead(404).end();
});

// Un WebSocketServer por canal y fuente; el enrutado por path se hace en `upgrade`.
// perMessageDeflate solo para mensajes grandes (snapshots); los deltas pequenos no se comprimen.
const routes = new Map<string, WebSocketServer>();
for (const [id, src] of sources)
  for (const [path, channel] of src.channels) {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
    wss.on("connection", (ws) => channel.add(ws));
    routes.set(sourcePath(id, path), wss);
  }
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
  chainlink.start();
  latencyMonitor.start();
  predictShared?.price.start();
  // la cuenta de Predict solo LEE de la cadena al arrancar (firmante, aprobaciones, saldo); el login es al activar
  void predictShared?.account.init().then(() => predictShared.latency.start());
  // las fuentes arrancan a la vez (el relleno de futures es mas lento por el rate limit y no debe retrasar a spot)
  await Promise.all([...sources.values()].map((s) => s.start()));
  console.log("[server] ready");
});

// reloj de la latencia: el de spot (estimado con sus trades)
latencyClock = () => spot.clock.now();
predictClock = () => spot.clock.now();
// market de Predict en curso (el de spot) para la latencia: libro y orden de prueba
predictMarket = () => {
  const m = spot.predict?.tracker.current;
  const id = m ? parseToken(m.upToken) : null;
  const info = id && predictShared ? predictShared.api.tradingInfo(id.marketId) : null;
  return id ? { marketId: id.marketId, upTokenId: info?.upTokenId ?? null, feeRateBps: info?.feeRateBps ?? 200 } : null;
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recibido`);
  // 1) backups finales PRIMERO, con todo aun en marcha (ADR 0013); las dos bases a la vez
  await Promise.all([...sources.values()].map((s) => s.finalBackup()));
  // 2) parar todo
  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error(`[shutdown] ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  step("chainlink", () => chainlink.stop());
  step("latency", () => latencyMonitor.stop());
  step("predict", () => predictShared?.price.stop());
  step("predict latency", () => predictShared?.latency.stop());
  step("predict account", () => predictShared?.account.stop());
  for (const s of sources.values()) await s.stop();
  console.log("[shutdown] listo");
  http.close(() => process.exit(0));
  // los WS abiertos mantienen vivo el servidor HTTP: la base ya esta cerrada, salir igualmente
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => console.error(`[server] promesa rechazada sin manejar: ${e instanceof Error ? e.stack : e}`));
