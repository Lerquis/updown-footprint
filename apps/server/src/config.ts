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
  /** Base de datos SQLite de markets completos (relativa al directorio del servidor) */
  pmDbPath: process.env.PM_DB_PATH ?? "data/polymarket.db",

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
} as const;
