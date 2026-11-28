import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { sourcePath, type CompareMarketRow, type CompareResponse, type MarketAsset, type MarketSource } from "@updown/protocol";
import { createReadStream, existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import { ChainlinkClient } from "./polymarket/chainlinkClient.js";
import { ChainlinkTwapClient } from "./polymarket/chainlinkTwapClient.js";
import { LatencyMonitor } from "./polymarket/latency.js";
import { compareMarkets, compareTotals } from "./polymarket/compare.js";
import { createSource, sourceLabel, splitSource, type AssetMarket, type RefFeed, type Source } from "./source.js";
// [PREDICT desactivado] import { PredictMarketApi } from "./predict/api.js";
// [PREDICT desactivado] import { PredictWs } from "./predict/wsClient.js";
// [PREDICT desactivado] import { PredictAccount } from "./predict/account.js";
// [PREDICT desactivado] import { PredictLatencyMonitor } from "./predict/latency.js";
// [PREDICT desactivado] import { parseToken } from "./predict/model.js";

/**
 * Composicion (ADR 0016 y 0018): lo compartido (Chainlink por activo, latencia al CLOB) + una fuente completa por activo (BTC
 * siempre; ETH si ETH_ENABLED) y mercado de Binance (spot siempre; futures si FUTURES_ENABLED). Cada fuente tiene sus canales
 * (`/ws/...`, `/ws/futures/...`, `/ws/eth/...`, `/ws/eth/futures/...`), su API, su base, sus backups y sus compras reales.
 * Aqui solo se enruta.
 */

// ── Compartido ──
// Precio de referencia: TWAP de Chainlink (PolyBolt, necesita credenciales CLOB) o, si faltan, el spot del RTDS antiguo.
const hasClob = Boolean(config.pmClob.apiKey && config.pmClob.secret && config.pmClob.passphrase);
const chainlink: ChainlinkClient | ChainlinkTwapClient = hasClob ? new ChainlinkTwapClient(config.pmTwapWsUrl, config.pmClob) : new ChainlinkClient(config.pmLiveWsUrl);
console.log(`[polymarket] price feed: ${hasClob ? "Chainlink TWAP 60s (PolyBolt)" : "Chainlink spot (RTDS, sin credenciales)"}`);
/** Chainlink ETH/USD (ADR 0018): el mismo tipo de feed que BTC, otra conexion */
const ec = config.eth;
const chainlinkEth: ChainlinkClient | ChainlinkTwapClient | null = !ec.enabled
  ? null
  : hasClob
    ? new ChainlinkTwapClient(config.pmTwapWsUrl, config.pmClob, ec.chainlinkTwapSymbol, 60, "eth:chainlink-twap")
    : new ChainlinkClient(config.pmLiveWsUrl, ec.chainlinkSymbol, "eth:chainlink");

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
// [PREDICT desactivado] const pc = config.predict;
// [PREDICT desactivado] // La cuenta (compras reales) y la latencia a su API tambien son comunes: cada fuente tiene su interruptor pero opera con la misma cuenta
// [PREDICT desactivado] let predictClock: () => number = () => Date.now();
// [PREDICT desactivado] let predictMarket: () => { marketId: number; upTokenId: string | null; feeRateBps: number } | null = () => null;
// [PREDICT desactivado] const predictShared = (() => {
  // [PREDICT desactivado] if (!pc.enabled || !pc.engines) return null;
  // [PREDICT desactivado] const api = new PredictMarketApi({ restUrl: pc.restUrl, apiKey: pc.apiKey, series: pc.series });
  // [PREDICT desactivado] const account = new PredictAccount({ restUrl: pc.restUrl, wsUrl: pc.wsUrl, apiKey: pc.apiKey, privateKey: pc.live.privateKey, predictAccount: pc.live.account });
  // [PREDICT desactivado] const latency = new PredictLatencyMonitor(
    // [PREDICT desactivado] { restUrl: pc.restUrl, apiKey: pc.apiKey, intervalMs: pc.latencyIntervalMs, historyMax: config.pmLatencyHistory },
    // [PREDICT desactivado] account,
    // [PREDICT desactivado] () => predictMarket(),
    // [PREDICT desactivado] () => predictClock(),
  // [PREDICT desactivado] );
  // [PREDICT desactivado] return { api, price: new PredictWs("predict-price", pc.wsUrl, pc.priceFeedId), account, latency };
// [PREDICT desactivado] })();
// [PREDICT desactivado] if (!predictShared) console.log("[predict] desactivado (PREDICT_ENABLED / PREDICT_ENGINES)");
// Mientras Predict este comentado, sus bases viejas (locales o en el volumen de Railway) se borran al arrancar. QUITAR al reactivarlo.
// Solo archivos cuyo nombre contiene "predict" (predict-v2.db, predict-futures-v2.db y sus -wal, -shm y .last-backup).
for (const base of [config.predict.dbPath, config.predict.futuresDbPath]) {
  if (!basename(base).includes("predict")) continue;
  for (const f of [base, `${base}-wal`, `${base}-shm`, `${base}.last-backup`]) {
    if (!existsSync(f)) continue;
    rmSync(f);
    console.log(`[predict] base vieja borrada: ${f}`);
  }
}
// Predict esta comentado entero: ni se importa ni consume nada. Para reactivarlo, quitar los "// [PREDICT desactivado]" y usar la linea de abajo.
// [PREDICT desactivado] const shared = { chainlink, latencyMonitor, predict: predictShared };
const shared = { chainlink, latencyMonitor };
const btcMarket: AssetMarket = {
  symbol: config.symbol,
  pmSymbol: config.pmSymbol,
  pmSlugPrefix: config.pmSlugPrefix,
  depthStep: config.depthStep,
  footprintTick: config.footprintTick,
  imbalanceMinVol: config.imbalanceMinVol,
};
const spot = await createSource(
  {
    id: "spot",
    asset: "btc",
    market: btcMarket,
    tradesWsUrl: config.binanceWsUrl,
    depthWsUrl: config.binanceWsUrl,
    restUrl: config.binanceRestUrl,
    depthMode: "spot",
    depthSnapshotLimit: config.depthSnapshotLimit,
    backfillPageDelayMs: 60,
    dbPath: config.pmDbPath,
    legacyDbPath: config.pmLegacyDbPath,
    backup: backupFor(bk.prefix),
    // [PREDICT desactivado] predictDbPath: pc.dbPath,
    // [PREDICT desactivado] predictBackup: backupFor(pc.backupPrefix),
  },
  shared,
);
const fc = config.futures;
/** Fuente futures de un activo (perpetuo USDⓈ-M) */
const futuresOf = (asset: MarketAsset, market: AssetMarket, dbPath: string, backupPrefix: string, deps: typeof shared, reference?: RefFeed) =>
  createSource(
    {
      id: "futures",
      asset,
      market,
      tradesWsUrl: fc.tradesWsUrl,
      depthWsUrl: fc.depthWsUrl,
      restUrl: fc.restUrl,
      depthMode: "futures",
      depthSnapshotLimit: fc.depthSnapshotLimit,
      backfillPageDelayMs: fc.backfillPageDelayMs,
      dbPath,
      legacyDbPath: null,
      backup: backupFor(backupPrefix),
      reference,
      // [PREDICT desactivado] predictDbPath: pc.futuresDbPath,
      // [PREDICT desactivado] predictBackup: backupFor(pc.futuresBackupPrefix),
    },
    deps,
  );
const futures = fc.enabled ? await futuresOf("btc", btcMarket, fc.dbPath, fc.backupPrefix, shared) : null;
if (!futures) console.log("[futures] desactivado (FUTURES_ENABLED=false)");

// ── ETH (ADR 0018): el mismo sistema con sus markets, su Chainlink y sus bases ──
const ethShared = chainlinkEth ? { chainlink: chainlinkEth, latencyMonitor } : null;
const ethMarket: AssetMarket = {
  symbol: ec.symbol,
  pmSymbol: ec.pmSymbol,
  pmSlugPrefix: ec.pmSlugPrefix,
  depthStep: ec.depthStep,
  footprintTick: ec.footprintTick,
  imbalanceMinVol: ec.imbalanceMinVol,
  strength: ec.strength,
};
const ethSpot = ethShared
  ? await createSource(
      {
        id: "spot",
        asset: "eth",
        market: ethMarket,
        tradesWsUrl: config.binanceWsUrl,
        depthWsUrl: config.binanceWsUrl,
        restUrl: config.binanceRestUrl,
        depthMode: "spot",
        depthSnapshotLimit: config.depthSnapshotLimit,
        backfillPageDelayMs: 60,
        dbPath: ec.dbPath,
        legacyDbPath: null,
        backup: backupFor(ec.backupPrefix),
        // SS: BTC de la misma fuente como referencia
        reference: spot.refFeed,
      },
      ethShared,
    )
  : null;
const ethFutures = ethShared && fc.enabled ? await futuresOf("eth", ethMarket, ec.futuresDbPath, ec.futuresBackupPrefix, ethShared, futures?.refFeed) : null;
if (!ethSpot) console.log("[eth] desactivado (ETH_ENABLED=false)");

/** Todas las fuentes por clave `sourceLabel` ("" = BTC spot, "futures", "eth", "eth-futures") */
const sources = new Map<string, Source>(
  [spot, futures, ethSpot, ethFutures].filter((s): s is Source => s !== null).map((s) => [sourceLabel(s.asset, s.id), s]),
);
const sourceOf = (asset: MarketAsset, source: MarketSource) => sources.get(sourceLabel(asset, source)) ?? null;
latencyToken = () => spot.tracker.current?.upToken ?? spot.tracker.next?.upToken ?? null;

// ── Comparativa spot vs futures (GET /api/compare) ──
/** filas ya calculadas de markets con el resultado de las dos fuentes (no cambian): no se vuelve a leer su JSON */
const compareCache = new Map<string, CompareMarketRow>();
function compare(asset: MarketAsset, limit: number): CompareResponse {
  const spot = sourceOf(asset, "spot");
  const futures = sourceOf(asset, "futures");
  if (!spot || !futures) return { markets: [], totals: compareTotals([]), futuresEnabled: false };
  const rows: CompareMarketRow[] = [];
  for (const { slug } of futures.marketStore.list({ limit })) {
    // los slugs de BTC y ETH no coinciden (btc-updown-5m-... / eth-updown-5m-...): una sola cache vale para los dos
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
        eth: ethSpot ? { spot: ethSpot.health(), futures: ethFutures ? ethFutures.health() : { enabled: false } } : { enabled: false },
        latency: { region: config.region, authReady: latencyMonitor.authReady, reconnects: latencyMonitor.reconnects, last: latencyMonitor.history.at(-1) ?? null },
      }),
    );
    return;
  }
  if (url.pathname === "/api/compare" && req.method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 96));
    const asset: MarketAsset = url.searchParams.get("asset") === "eth" ? "eth" : "btc";
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(compare(asset, limit)));
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
  const { asset, source, path } = splitSource(url.pathname);
  const src = sourceOf(asset, source);
  if (src?.handleHttp(req, res, path, url)) return;
  res.writeHead(404).end();
});

// Un WebSocketServer por canal y fuente; el enrutado por path se hace en `upgrade`.
// perMessageDeflate solo para mensajes grandes (snapshots); los deltas pequenos no se comprimen.
const routes = new Map<string, WebSocketServer>();
for (const src of sources.values())
  for (const [path, channel] of src.channels) {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
    wss.on("connection", (ws) => channel.add(ws));
    routes.set(sourcePath(src.id, path, src.asset), wss);
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
  chainlinkEth?.start();
  latencyMonitor.start();
  // [PREDICT desactivado] predictShared?.price.start();
  // [PREDICT desactivado] // la cuenta de Predict solo LEE de la cadena al arrancar (firmante, aprobaciones, saldo); el login es al activar
  // [PREDICT desactivado] void predictShared?.account.init().then(() => predictShared.latency.start());
  // las fuentes arrancan a la vez (el relleno de futures es mas lento por el rate limit y no debe retrasar a spot)
  await Promise.all([...sources.values()].map((s) => s.start()));
  console.log("[server] ready");
});

// reloj de la latencia: el de spot (estimado con sus trades)
latencyClock = () => spot.clock.now();
// [PREDICT desactivado] predictClock = () => spot.clock.now();
// [PREDICT desactivado] // market de Predict en curso (el de spot) para la latencia: libro y orden de prueba
// [PREDICT desactivado] predictMarket = () => {
  // [PREDICT desactivado] const m = spot.predict?.tracker.current;
  // [PREDICT desactivado] const id = m ? parseToken(m.upToken) : null;
  // [PREDICT desactivado] const info = id && predictShared ? predictShared.api.tradingInfo(id.marketId) : null;
  // [PREDICT desactivado] return id ? { marketId: id.marketId, upTokenId: info?.upTokenId ?? null, feeRateBps: info?.feeRateBps ?? 200 } : null;
// [PREDICT desactivado] };

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recibido`);
  // 1) backups finales PRIMERO, con todo aun en marcha (ADR 0013); todas las bases a la vez
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
  step("eth chainlink", () => chainlinkEth?.stop());
  step("latency", () => latencyMonitor.stop());
  // [PREDICT desactivado] step("predict", () => predictShared?.price.stop());
  // [PREDICT desactivado] step("predict latency", () => predictShared?.latency.stop());
  // [PREDICT desactivado] step("predict account", () => predictShared?.account.stop());
  for (const s of sources.values()) await s.stop();
  console.log("[shutdown] listo");
  http.close(() => process.exit(0));
  // los WS abiertos mantienen vivo el servidor HTTP: la base ya esta cerrada, salir igualmente
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => console.error(`[server] promesa rechazada sin manejar: ${e instanceof Error ? e.stack : e}`));
