import { basename, join, resolve, sep } from "node:path";

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
  // ── Compras reales del motor C (/ws/trading, docs/features/live-trading.md). Sin clave o sin contrasena: desactivado ──
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
    /** peor precio aceptado frente a la senal (0.02 = 2c) */
    slippage: num(process.env.PM_LIVE_SLIPPAGE, 0.02),
    tick: 0.01,
    minShares: 5,
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
  pmWarmupS: num(process.env.PM_WARMUP_S, 20),
  pmNoEntryS: num(process.env.PM_NO_ENTRY_S, 10),
  /**
   * Motores A, B y C (docs/features/engines.md): deciden cada segundo de Binance + este retraso (ms).
   * A con lo ultimo recibido (lo antes posible); B y C con datos "a fecha" del segundo.
   */
  pmEngineDelayMs: {
    a: num(process.env.PM_ENGINE_A_DELAY_MS, 0),
    b: num(process.env.PM_ENGINE_B_DELAY_MS, 300),
    c: num(process.env.PM_ENGINE_C_DELAY_MS, 150),
  },
} as const;
