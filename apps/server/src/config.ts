import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Generacion de la base de datos: al cambiar el formato de lo que se guarda se empieza una base nueva
 * (`polymarket.db` -> `polymarket-v2.db`) y otra carpeta de backups, sin tocar lo anterior. Ver ADR 0011.
 */
export const DB_GENERATION = "v2";
const withGeneration = (path: string) => path.replace(/(\.db)?$/, `-${DB_GENERATION}.db`);

/**
 * Ruta de la base. Si hay un volumen montado (Railway define RAILWAY_VOLUME_MOUNT_PATH) y la ruta pedida queda FUERA de el,
 * se usa el mismo nombre de archivo dentro del volumen: fuera del volumen la base se borra en cada deploy.
 * (El 27 nov se perdieron ~22 h asi: PM_DB_PATH=data/polymarket.db relativo en Railway, ADR 0013.)
 */
export function resolveDbPath(requested: string, volumeMount: string | undefined): string {
  if (!volumeMount) return requested;
  const vol = resolve(volumeMount);
  const abs = resolve(requested);
  return abs === vol || abs.startsWith(vol + sep) ? requested : join(vol, basename(requested));
}
const dbRequested = process.env.PM_DB_PATH ?? "data/polymarket.db";
const dbBase = resolveDbPath(dbRequested, process.env.RAILWAY_VOLUME_MOUNT_PATH);
if (dbBase !== dbRequested)
  console.warn(`[db] PM_DB_PATH=${dbRequested} esta fuera del volumen ${process.env.RAILWAY_VOLUME_MOUNT_PATH}: se usa ${dbBase}`);
const prefixBase = process.env.BACKUP_PREFIX ?? "updown/";
/** Base de la fuente futures (ADR 0016): otra base, al lado de la de spot salvo que FUTURES_DB_PATH diga otra cosa */
const futuresDbRequested = process.env.FUTURES_DB_PATH ?? join(dirname(dbRequested), "polymarket-futures.db");
const futuresDbBase = resolveDbPath(futuresDbRequested, process.env.RAILWAY_VOLUME_MOUNT_PATH);

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === "1" || v.toLowerCase() === "true");

/** Memoria de datos de mercado (trades, heatmap, CVD): 15 min por defecto. */
const retentionMs = num(process.env.RETENTION_MS, 15 * 60_000);
const depthIntervalMs = num(process.env.DEPTH_INTERVAL_MS, 1000);

export const config = {
  port: num(process.env.PORT, 4000),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "",
  symbol: (process.env.SYMBOL ?? "btcusdt").toLowerCase(),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? "wss://stream.binance.com:9443/ws",
  binanceRestUrl: process.env.BINANCE_REST_URL ?? "https://api.binance.com/api/v3",

  /**
   * Fuente futures (perpetuo USDⓈ-M, ADR 0016): mismo sistema (motores, base, compras reales) con los datos de futuros.
   * Su base y sus backups van aparte; la de spot no se toca.
   */
  futures: {
    enabled: bool(process.env.FUTURES_ENABLED, true),
    /**
     * Binance separo las rutas WS de futuros: aggTrade solo llega por /market (en la ruta antigua /ws conecta pero no envia nada)
     * y el libro (depth) por /public.
     */
    tradesWsUrl: process.env.BINANCE_FUTURES_TRADES_WS_URL ?? "wss://fstream.binance.com/market/ws",
    depthWsUrl: process.env.BINANCE_FUTURES_DEPTH_WS_URL ?? "wss://fstream.binance.com/public/ws",
    restUrl: process.env.BINANCE_FUTURES_REST_URL ?? "https://fapi.binance.com/fapi/v1",
    /** el snapshot REST del libro de futuros admite como maximo 1000 niveles */
    depthSnapshotLimit: num(process.env.FUTURES_DEPTH_SNAPSHOT_LIMIT, 1000),
    /** pausa entre paginas del relleno: /fapi/v1/aggTrades pesa 20 (limite 2400/min) */
    backfillPageDelayMs: num(process.env.FUTURES_BACKFILL_DELAY_MS, 600),
    dbPath: withGeneration(futuresDbBase),
    /** carpeta propia en el bucket, fuera de la de spot (p. ej. updown-futures/v2/) */
    backupPrefix: `${prefixBase.replace(/\/$/, "")}-futures/${DB_GENERATION}/`,
  },

  /**
   * ETH (ADR 0018): un clon completo de BTC (spot + futures si FUTURES_ENABLED) con sus markets ETH Up/Down 5m, su Chainlink ETH/USD
   * y sus bases/backups aparte. Los parametros de motores y estrategia son los de BTC (todo es relativo al precio); solo cambian
   * los tamanos de precio y volumen del heatmap y del footprint.
   */
  // PRUEBA (27 nov): el hueco de ETH consume SOLANA (SOLUSDT, markets sol-updown-5m, Chainlink SOL/USD). En la web sigue
  // llamandose "ETH". Para volver a ETH: restaurar los valores por defecto de este bloque (ethusdt, ETH, eth-updown-5m, ethusd,
  // eth/usd, 0.05, 0.05, 1.5, polymarket-eth*.db, updown-eth*).
  eth: {
    enabled: bool(process.env.ETH_ENABLED, true),
    symbol: (process.env.ETH_SYMBOL ?? "solusdt").toLowerCase(),
    pmSymbol: process.env.ETH_PM_SYMBOL ?? "SOL",
    pmSlugPrefix: process.env.ETH_PM_SLUG_PREFIX ?? "sol-updown-5m",
    /** Chainlink ETH/USD: TWAP de PolyBolt y spot del RTDS (respaldo) */
    chainlinkTwapSymbol: process.env.ETH_CHAINLINK_TWAP_SYMBOL ?? "solusd",
    chainlinkSymbol: process.env.ETH_CHAINLINK_SYMBOL ?? "sol/usd",
    /** SOL ~72 USDT: 0.01 es el tick minimo de Binance (ETH: 0.05) */
    depthStep: num(process.env.ETH_DEPTH_STEP, 0.01),
    footprintTick: num(process.env.ETH_FOOTPRINT_TICK, 0.01),
    /** ~el mismo valor en USD que 0.05 BTC (ETH: 1.5) */
    imbalanceMinVol: num(process.env.ETH_IMBALANCE_MIN_VOL, 40),
    /** SS (movimientos con fuerza del motor C, con BTC de referencia): docs/features/sol-strength.md */
    strength: bool(process.env.ETH_STRENGTH, true),
    dbPath: withGeneration(resolveDbPath(process.env.ETH_DB_PATH ?? join(dirname(dbRequested), "polymarket-sol.db"), process.env.RAILWAY_VOLUME_MOUNT_PATH)),
    futuresDbPath: withGeneration(
      resolveDbPath(process.env.ETH_FUTURES_DB_PATH ?? join(dirname(dbRequested), "polymarket-sol-futures.db"), process.env.RAILWAY_VOLUME_MOUNT_PATH),
    ),
    /** carpetas propias en el bucket (p. ej. updown-eth/v2/ y updown-eth-futures/v2/) */
    backupPrefix: `${prefixBase.replace(/\/$/, "")}-sol/${DB_GENERATION}/`,
    futuresBackupPrefix: `${prefixBase.replace(/\/$/, "")}-sol-futures/${DB_GENERATION}/`,
  },

  retentionMs,
  /** Tope de seguridad de trades en memoria (además del límite por tiempo) */
  tradesMax: num(process.env.TRADES_MAX, 100_000),
  /** Al arrancar, rellenar `retentionMs` de trades con el REST de Binance (CVD y footprint nacen con historia) */
  backfill: bool(process.env.BACKFILL, true),

  // ── Heatmap de liquidez (/ws/depth) ──
  /** Tamano del bucket de precio del heatmap (ej. 1 USDT para BTC) */
  depthStep: num(process.env.DEPTH_STEP, 1),
  /** Rango del heatmap alrededor del mid, como fraccion (0.001 = ±0.1%) */
  depthRangePct: num(process.env.DEPTH_RANGE_PCT, 0.001),
  depthIntervalMs,
  /** Columnas guardadas: una por muestreo durante `retentionMs` */
  depthHistory: num(process.env.DEPTH_HISTORY, Math.ceil(retentionMs / depthIntervalMs)),
  depthSnapshotLimit: num(process.env.DEPTH_SNAPSHOT_LIMIT, 5000),

  // ── Orderflow: footprint / CVD / señales (/ws/orderflow) ──
  /** Duración de cada barra footprint */
  barMs: num(process.env.BAR_MS, 60_000),
  /** Barras cerradas conservadas (60 x 1 min = 1 h; da contexto a las divergencias) */
  barHistory: num(process.env.BAR_HISTORY, 60),
  /** Tamano del nivel de precio del footprint */
  footprintTick: num(process.env.FOOTPRINT_TICK, 1),
  /** Desequilibrio diagonal: volumen >= ratio × volumen del nivel contrario adyacente */
  imbalanceRatio: num(process.env.IMBALANCE_RATIO, 3),
  /** Volumen mínimo (activo base) para que un nivel cuente como desequilibrio */
  imbalanceMinVol: num(process.env.IMBALANCE_MIN_VOL, 0.05),
  /** Niveles consecutivos necesarios para "apilado" */
  imbalanceMinStack: num(process.env.IMBALANCE_MIN_STACK, 3),

  // ── Monitor de escenarios (/ws/analysis) ──
  /** Ventana para medir tendencia de precio y CVD */
  analysisLookbackMs: num(process.env.ANALYSIS_LOOKBACK_MS, 5 * 60_000),
  /** Cuántas barras atrás se consideran "señales recientes" */
  analysisRecentBars: num(process.env.ANALYSIS_RECENT_BARS, 3),

  // ── Markets de Polymarket (/ws/polymarket) ──
  pmLiveWsUrl: process.env.PM_LIVE_WS_URL ?? "wss://ws-live-data.polymarket.com/",
  /** PolyBolt (ws-live-v2): TWAP de Chainlink con credenciales CLOB. Se leen de apps/server/.env.local (gitignored). */
  pmTwapWsUrl: process.env.PM_TWAP_WS_URL ?? "wss://ws-live-v2.polymarket.com/ws",
  pmClob: {
    apiKey: process.env.PM_CLOB_API_KEY ?? "",
    secret: process.env.PM_CLOB_SECRET ?? "",
    passphrase: process.env.PM_CLOB_PASSPHRASE ?? "",
  },
  /** CLOB REST de Polymarket (mismo host al que se envian las ordenes) */
  pmClobUrl: process.env.PM_CLOB_URL ?? "https://clob.polymarket.com",
  /** EOA que creo la API key (POLY_ADDRESS de las cabeceras L2). Sin ella las peticiones autenticadas responden 401. */
  pmSignerAddress: (process.env.PM_SIGNER_ADDRESS ?? "").trim(),
  /** Proxy wallet de la cuenta (maker de las ordenes; gamma /public-profile?address=<signer> -> proxyWallet) */
  pmFunderAddress: (process.env.PM_FUNDER_ADDRESS ?? "").trim(),
  // ── Latencia hacia el CLOB (/ws/latency, docs/features/latency.md): solo lectura, nunca opera ──
  pmLatencyIntervalMs: num(process.env.PM_LATENCY_INTERVAL_MS, 15_000),
  // ── Compras reales del motor A o C (/ws/trading, docs/features/live-trading.md). Sin clave o sin contrasena: desactivado ──
  live: {
    /** clave privada de la EOA firmante (la de PM_SIGNER_ADDRESS). SOLO en .env.local / variables de Railway */
    privateKey: process.env.PM_WALLET_PRIVATE_KEY ?? "",
    /** contrasena del interruptor de la web (cabecera x-trading-password) */
    password: process.env.TRADING_PASSWORD ?? "",
    /** real = paper x scale (paper 5..50 USDC -> 1..10) */
    scale: num(process.env.PM_LIVE_SCALE, 0.2),
    minUsd: num(process.env.PM_LIVE_MIN_USD, 1),
    maxUsd: num(process.env.PM_LIVE_MAX_USD, 10),
    maxMarketUsd: num(process.env.PM_LIVE_MAX_MARKET_USD, 40),
    /** peor precio aceptado frente a la senal (0.02 = 2c). Por defecto SIN LIMITE (1 -> compra hasta 0.99, vende desde 0.01) */
    slippage: num(process.env.PM_LIVE_SLIPPAGE, 1),
    tick: 0.01,
    minShares: 5,
    /** canal de usuario: hora exacta (ms) de cada ejecucion */
    userWsUrl: process.env.PM_USER_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user",
  },
  /**
   * Check maker (docs/features/latency.md): ordenes maker REALES (post-only a mejor bid + 1 tick) que siguen las senales del motor
   * elegido, de max(minUsd, minShares tokens), canceladas a los `restMs`. Apagado hasta activarlo con la contrasena de trading.
   */
  makerProbe: {
    max: num(process.env.PM_MAKER_CHECK_MAX, 30),
    restMs: num(process.env.PM_MAKER_CHECK_REST_MS, 2000),
    minUsd: num(process.env.PM_MAKER_CHECK_USD, 1),
    minShares: 5,
    maxMarketUsd: num(process.env.PM_LIVE_MAX_MARKET_USD, 40),
    tick: 0.01,
    settleMs: 1500,
  },
  /** PING de HTTP/2 para mantener caliente la conexion al CLOB */
  pmLatencyKeepAliveMs: num(process.env.PM_LATENCY_KEEPALIVE_MS, 5_000),
  /** desde donde mide el servidor (Railway la define; en local no existe) */
  region: process.env.RAILWAY_REPLICA_REGION ?? "local",
  /** Rondas guardadas en memoria (40 x 15 s = 10 min) */
  pmLatencyHistory: num(process.env.PM_LATENCY_HISTORY, 40),
  pmBookWsUrl: process.env.PM_BOOK_WS_URL ?? "wss://ws-subscriptions-frontend-clob.polymarket.com/ws/market",
  pmGammaUrl: process.env.PM_GAMMA_URL ?? "https://gamma-api.polymarket.com",
  pmSiteUrl: process.env.PM_SITE_URL ?? "https://polymarket.com",
  /** Activo y timeframe del market (solo BTC 5m por ahora) */
  pmSymbol: process.env.PM_SYMBOL ?? "BTC",
  pmVariant: process.env.PM_VARIANT ?? "fiveminute",
  pmSlugPrefix: process.env.PM_SLUG_PREFIX ?? "btc-updown-5m",
  /** Ventana del TWAP de Chainlink con que Polymarket resuelve (price to beat y cierre) */
  pmTwapSeconds: num(process.env.PM_TWAP_SECONDS, 60),
  pmMarketMs: num(process.env.PM_MARKET_MS, 5 * 60_000),
  /** Markets terminados que se guardan en memoria (24 x 5 min = 2 h) */
  pmHistory: num(process.env.PM_HISTORY, 24),
  /** Base de datos SQLite de markets completos (relativa al directorio del servidor): PM_DB_PATH con la generacion, p. ej. data/polymarket-v2.db */
  pmDbPath: withGeneration(dbBase),
  /** Base de la generacion anterior (PM_DB_PATH tal cual): si existe, se archiva una vez en el bucket y no se vuelve a tocar */
  pmLegacyDbPath: dbBase,

  // ── Backups de la base a un bucket S3/R2 (ver docs/guides/deployment.md). Desactivado si falta el bucket. ──
  backup: {
    s3: {
      endpoint: process.env.BACKUP_S3_ENDPOINT ?? "",
      bucket: process.env.BACKUP_S3_BUCKET ?? "",
      accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY ?? "",
      region: process.env.BACKUP_S3_REGION ?? "auto",
    },
    /** prefijo base (p. ej. updown/): ahi quedaron los backups de la generacion v1, sin carpeta propia */
    rootPrefix: prefixBase,
    /** carpeta de los backups de esta generacion (p. ej. updown/v2/) */
    prefix: `${prefixBase}${DB_GENERATION}/`,
    /** carpeta del archivo final de la base anterior (p. ej. updown/archive/) */
    archivePrefix: `${prefixBase}archive/`,
    /** cada hora: si el volumen se pierde, como mucho se pierde 1 h (ADR 0013) */
    intervalMs: num(process.env.BACKUP_INTERVAL_H, 1) * 3600_000,
    /** todas las copias de las ultimas 48 h; las anteriores, una por dia */
    keepHours: num(process.env.BACKUP_KEEP_H, 48),
    /** tiempo maximo del backup final al apagar (railway.json drainingSeconds debe ser mayor) */
    shutdownTimeoutMs: num(process.env.BACKUP_SHUTDOWN_TIMEOUT_S, 150) * 1000,
    /** Programar backups periodicos (false: solo restaurar / backups manuales) */
    enabled: bool(process.env.BACKUP_ENABLED, true),
    /** Al arrancar sin base, descargar el ultimo backup */
    /** en Railway por defecto si: restaurar solo actua si falta la base (nunca sobrescribe) */
    restore: bool(process.env.PM_DB_RESTORE, Boolean(process.env.RAILWAY_ENVIRONMENT)),
  },

  // ── Motor de senales (ver docs/features/signal-engine.md) ──
  /** Comision de taker del market (0.05 en BTC 5m/15m, segun docs.polymarket.com/trading/fees) */
  pmFeeRate: num(process.env.PM_FEE_RATE, 0.05),
  pmSlippage: num(process.env.PM_SLIPPAGE, 0.005),
  /** EV minimo por token (USDC) para senalar una compra */
  pmMinEdge: num(process.env.PM_MIN_EDGE, 0.04),
  pmExitMargin: num(process.env.PM_EXIT_MARGIN, 0.015),
  /** Bankroll de referencia (USDC) con el que se dimensionan las entradas */
  pmBankroll: num(process.env.PM_BANKROLL, 1000),
  pmKellyFraction: num(process.env.PM_KELLY_FRACTION, 0.25),
  pmMaxStakePct: num(process.env.PM_MAX_STAKE_PCT, 0.05),
  pmMaxMarketPct: num(process.env.PM_MAX_MARKET_PCT, 0.1),
  /** Peso del modelo al mezclar con la probabilidad del mercado (1 = solo modelo) */
  pmModelWeight: num(process.env.PM_MODEL_WEIGHT, 0.6),
  /** Cuanto desplaza el flujo la media (0 = ignorar el flujo) */
  pmFlowGain: num(process.env.PM_FLOW_GAIN, 0.3),
  /** Replays del motor A con ejecucion retrasada (docs/features/replays.md): copias descargadas de R2 e informe (report.json) */
  replayDir: process.env.REPLAY_DIR ?? "data/replays",
  pmWarmupS: num(process.env.PM_WARMUP_S, 20),
  pmNoEntryS: num(process.env.PM_NO_ENTRY_S, 10),
  /**
   * Motores A y C (docs/features/engines.md): deciden cada segundo de Binance + este retraso (ms).
   * A con lo ultimo recibido (lo antes posible); C con datos "a fecha" del segundo. (El motor B, +300 ms, se elimino.)
   */
  pmEngineDelayMs: {
    a: num(process.env.PM_ENGINE_A_DELAY_MS, 0),
    c: num(process.env.PM_ENGINE_C_DELAY_MS, 150),
  },
  // ── Predict.fun (rondas BTC Up/Down 5m, docs/features/predict-markets.md) ──
  predict: {
    enabled: bool(process.env.PREDICT_ENABLED, true),
    restUrl: process.env.PREDICT_REST_URL ?? "https://api.predict.fun",
    wsUrl: process.env.PREDICT_WS_URL ?? "wss://ws.predict.fun/ws",
    /** mainnet exige API key incluso para leer el REST (el WS es publico). SOLO en .env.local / Railway */
    apiKey: process.env.PREDICT_API_KEY ?? "",
    series: process.env.PREDICT_SERIES ?? "btc-updown-5m",
    /** feed de chainlinkAssetPriceUpdate: 1 = BTC, 2 = ETH, 3 = BNB */
    priceFeedId: num(process.env.PREDICT_PRICE_FEED_ID, 1),
    /** comision taker de los motores: feeRate · min(p, 1-p) (feeRateBps 200 de los markets 5m = 0.02) */
    feeRate: num(process.env.PREDICT_FEE_RATE, 0.02),
    /** ventana (s) de la media de Binance para el basis contra el Chainlink puntual */
    basisSeconds: num(process.env.PREDICT_BASIS_SECONDS, 5),
    /** motores sobre Predict (A y C en papel, una pila por fuente) */
    engines: bool(process.env.PREDICT_ENGINES, true),
    /** bases de los markets de Predict (solo markets; los aggTrades estan en la base de cada fuente), junto a la de spot */
    dbPath: withGeneration(resolveDbPath(process.env.PREDICT_DB_PATH ?? join(dirname(dbRequested), "predict.db"), process.env.RAILWAY_VOLUME_MOUNT_PATH)),
    futuresDbPath: withGeneration(resolveDbPath(process.env.PREDICT_FUTURES_DB_PATH ?? join(dirname(dbRequested), "predict-futures.db"), process.env.RAILWAY_VOLUME_MOUNT_PATH)),
    /** carpetas propias en el bucket de backups (p. ej. updown-predict/v2/ y updown-predict-futures/v2/) */
    backupPrefix: `${prefixBase.replace(/\/$/, "")}-predict/${DB_GENERATION}/`,
    futuresBackupPrefix: `${prefixBase.replace(/\/$/, "")}-predict-futures/${DB_GENERATION}/`,
    /**
     * Compras reales en Predict (docs/features/predict-markets.md#compras-reales). Clave SOLO en .env.local / Railway.
     * privateKey: la de la EOA, o la de la wallet de Privy (exportada en predict.fun/account/settings) si se usa una cuenta de Predict;
     * account: direccion de la cuenta de Predict (predict.fun/portfolio), vacia = se opera con la EOA. Contrasena: TRADING_PASSWORD.
     */
    live: {
      privateKey: process.env.PREDICT_PRIVATE_KEY ?? "",
      account: process.env.PREDICT_ACCOUNT ?? "",
      /** real = paper x scale */
      scale: num(process.env.PREDICT_LIVE_SCALE, 0.2),
      /** minimo por compra (USDT); nunca baja del minimo de Predict (1 USDT) */
      minUsd: Math.max(1, num(process.env.PREDICT_LIVE_MIN_USD, 1)),
      maxUsd: num(process.env.PREDICT_LIVE_MAX_USD, 10),
      maxMarketUsd: num(process.env.PREDICT_LIVE_MAX_MARKET_USD, 40),
      /** deslizamiento de A y C sobre el peor nivel del libro (bps); D usa su limite */
      slippageBps: Math.min(9999, Math.max(0, num(process.env.PREDICT_LIVE_SLIPPAGE_BPS, 500))),
    },
    /** latencia a la API de ordenes (solo lectura) */
    latencyIntervalMs: num(process.env.PREDICT_LATENCY_INTERVAL_MS, 15_000),
  },
} as const;
