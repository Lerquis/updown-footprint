/**
 * Contrato servidor <-> frontend. ÚNICA fuente de verdad de los mensajes WebSocket.
 * Ver docs/architecture/protocol.md. Cambios aquí => actualizar ese doc.
 *
 * Todos los timestamps (`time`, `start`, ...) están en ms y en el RELOJ DE BINANCE.
 */

/** Trade agregado normalizado (el servidor traduce el payload crudo de Binance). */
export interface AggTrade {
  /** aggregate trade id (Binance `a`) */
  id: number;
  symbol: string;
  price: number;
  quantity: number;
  /** timestamp del trade en ms (Binance `T`) */
  time: number;
  /** true => el comprador es maker => la agresión fue VENDEDORA */
  isBuyerMaker: boolean;
}

export type UpstreamState = "connecting" | "connected" | "reconnecting";

/** Rutas de los canales WebSocket expuestos por el servidor. */
export const CHANNELS = {
  aggTrades: "/ws/aggtrades",
  depth: "/ws/depth",
  orderflow: "/ws/orderflow",
  analysis: "/ws/analysis",
  polymarket: "/ws/polymarket",
  engines: "/ws/engines",
  latency: "/ws/latency",
  trading: "/ws/trading",
} as const;

/**
 * Mercado de Binance del que salen los datos (ADR 0016). Cada fuente tiene TODOS los canales y la API de markets/trading propios,
 * con sus motores, su base de datos y sus compras reales; Polymarket (Chainlink, latencia al CLOB) es el mismo para las dos.
 * spot: BTCUSDT spot (las rutas de siempre) · futures: perpetuo BTCUSDT USDⓈ-M (rutas con `/futures`).
 */
export type MarketSource = "spot" | "futures";
export const SOURCES: readonly MarketSource[] = ["spot", "futures"];

/**
 * Ruta de un canal (`CHANNELS.x`) o de la API HTTP (`/api/...`) para una fuente.
 * spot = la ruta tal cual · futures: `/ws/orderflow` -> `/ws/futures/orderflow`, `/api/markets` -> `/api/futures/markets`.
 */
export function sourcePath(source: MarketSource, path: string): string {
  return source === "spot" ? path : path.replace(/^\/(ws|api)\//, `/$1/${source}/`);
}

// ───────────────────────── Canal aggTrades ─────────────────────────

/** Mensajes servidor -> cliente del canal aggTrades. */
export type AggTradesServerMessage =
  | {
      type: "snapshot";
      symbol: string;
      /** Memoria del servidor en ms: el cliente descarta trades más viejos que `ultimo - retentionMs` */
      retentionMs: number;
      trades: AggTrade[];
      upstream: UpstreamState;
    }
  | { type: "trade"; trade: AggTrade }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal depth (heatmap de liquidez) ─────────────────────────

/**
 * Una "columna" del heatmap: foto del libro de ordenes agregado en buckets de precio.
 * El nivel i cubre [lo + i*step, lo + (i+1)*step). `lo` es multiplo de `step`, asi que
 * las columnas quedan alineadas en la rejilla de precios absoluta.
 */
export interface DepthColumn {
  /** instante de la foto en ms, en el reloj de Binance (igual que AggTrade.time) */
  time: number;
  /** precio medio (best bid + best ask) / 2 */
  mid: number;
  /** precio inferior del bucket 0 */
  lo: number;
  /** liquidez (cantidad en activo base) por bucket, bids y asks combinados */
  q: number[];
}

export type DepthServerMessage =
  | {
      type: "snapshot";
      symbol: string;
      step: number;
      retentionMs: number;
      columns: DepthColumn[];
      upstream: UpstreamState;
    }
  | { type: "column"; column: DepthColumn }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal orderflow (footprint, CVD, señales) ─────────────────────────

/** Nivel de una barra footprint: [precio, volumen vendedor agresivo (bid), volumen comprador agresivo (ask)] */
export type FootprintLevel = [price: number, bidVol: number, askVol: number];

/** Desequilibrio diagonal en un nivel (ver docs/features/orderflow-signals.md). */
export interface ImbalanceMark {
  price: number;
  /** buy: ask >= ratio × bid del nivel inferior · sell: bid >= ratio × ask del nivel superior */
  side: "buy" | "sell";
}

/** Barra footprint: vela de `barMs` con volumen bid/ask por nivel de precio. */
export interface FootprintBar {
  /** inicio de la barra, alineado a `barMs` */
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** askVol - bidVol de toda la barra */
  delta: number;
  /** CVD al cierre de la barra (o el valor actual si sigue formándose) */
  cvdClose: number;
  /** false mientras la barra se está formando */
  closed: boolean;
  /** niveles en orden ascendente de precio */
  levels: FootprintLevel[];
  imbalances: ImbalanceMark[];
}

/** CVD (cumulative volume delta) muestreado cada segundo. Arranca en 0 al inicio de la memoria del servidor. */
export interface CvdPoint {
  /** fin del segundo */
  time: number;
  cvd: number;
  /** último precio operado hasta ese instante */
  price: number;
  /** volumen operado en ese segundo */
  vol: number;
}

export type SignalType = "stackedImbalance" | "absorption" | "exhaustion" | "cvdDivergence";
export type Bias = "bullish" | "bearish";

export interface SignalPoint {
  time: number;
  price: number;
  cvd: number;
}

/** Señal detectada por el servidor al cierre de una barra. */
export interface OrderflowSignal {
  id: string;
  type: SignalType;
  /** implicación de la señal: alcista o bajista */
  bias: Bias;
  barStart: number;
  /** momento de detección (cierre de la barra) */
  time: number;
  /** zona de precio de la señal */
  priceLo: number;
  priceHi: number;
  /** stackedImbalance: nº de niveles apilados · absorption/exhaustion: cuota de volumen (0-1) en la zona · cvdDivergence: diferencia de CVD */
  strength: number;
  /** solo cvdDivergence: puntos de precio/CVD que divergen */
  link?: { from: SignalPoint; to: SignalPoint };
}

export type OrderflowServerMessage =
  | {
      type: "snapshot";
      symbol: string;
      /** tamaño del nivel de precio del footprint */
      tick: number;
      /** duración de cada barra */
      barMs: number;
      retentionMs: number;
      bars: FootprintBar[];
      cvd: CvdPoint[];
      signals: OrderflowSignal[];
      upstream: UpstreamState;
    }
  /** Barra en formación (cada segundo) o recién cerrada; el cliente reemplaza por `start` */
  | { type: "bar"; bar: FootprintBar }
  | { type: "cvd"; point: CvdPoint }
  | { type: "signal"; signal: OrderflowSignal }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal analysis (monitor de escenarios) ─────────────────────────

export type Trend = "up" | "down" | "flat";
export type ScenarioBias = Bias | "neutral";

export interface ScenarioDef {
  id: string;
  title: string;
  bias: ScenarioBias;
  /** condición, en lenguaje llano */
  when: string;
  /** qué significa */
  meaning: string;
}

/**
 * Catálogo de escenarios. El servidor evalúa las condiciones (apps/server/src/analysis/scenarios.ts,
 * una función por id); el frontend muestra estos textos. Mantener ids en sincronía con esa tabla.
 */
export const SCENARIOS = [
  // ── Precio × CVD (9 combinaciones) ──
  {
    id: "up-confirmed",
    title: "Subida respaldada por flujo",
    bias: "bullish",
    when: "Precio sube y el CVD sube.",
    meaning:
      "Los compradores agresivos empujan el precio: el movimiento tiene respaldo. Mientras no aparezcan agotamiento ni absorción vendedora, la tendencia alcista se considera sana.",
  },
  {
    id: "down-confirmed",
    title: "Caída respaldada por flujo",
    bias: "bearish",
    when: "Precio baja y el CVD baja.",
    meaning:
      "Los vendedores agresivos empujan el precio: la caída tiene respaldo. Mientras no aparezcan agotamiento ni absorción compradora, la tendencia bajista se considera sana.",
  },
  {
    id: "balance",
    title: "Equilibrio",
    bias: "neutral",
    when: "Precio y CVD sin dirección clara.",
    meaning:
      "Ni compradores ni vendedores toman el control. Suele ser rango o consolidación; vigila rupturas acompañadas de desequilibrios apilados.",
  },
  {
    id: "up-cvd-down",
    title: "Sube pese a ventas agresivas",
    bias: "neutral",
    when: "Precio sube pero el CVD baja.",
    meaning:
      "Dominan las ventas agresivas y aun así el precio sube: puede ser compra pasiva grande que absorbe (alcista) o un rally sin respaldo que se agota (bajista). Confirma con absorción o agotamiento.",
  },
  {
    id: "down-cvd-up",
    title: "Cae pese a compras agresivas",
    bias: "neutral",
    when: "Precio baja pero el CVD sube.",
    meaning:
      "Hay compras agresivas pero el precio baja: ventas pasivas grandes las absorben o los compradores quedan atrapados. Confirma con absorción vendedora o con agotamiento vendedor (posible giro).",
  },
  {
    id: "up-cvd-flat",
    title: "Sube sin flujo claro",
    bias: "neutral",
    when: "Precio sube y el CVD está plano.",
    meaning: "Subida débil: no la acompaña flujo comprador neto. Es más frágil que una subida confirmada.",
  },
  {
    id: "down-cvd-flat",
    title: "Baja sin flujo claro",
    bias: "neutral",
    when: "Precio baja y el CVD está plano.",
    meaning: "Caída débil: no la acompaña flujo vendedor neto. Es más frágil que una caída confirmada.",
  },
  {
    id: "flat-cvd-up",
    title: "Compras sin avance de precio",
    bias: "neutral",
    when: "Precio plano y el CVD sube.",
    meaning:
      "Compradores agresivos que no consiguen mover el precio: alguien vende pasivamente (techo) o se está acumulando. Atento a una ruptura o a una absorción.",
  },
  {
    id: "flat-cvd-down",
    title: "Ventas sin avance de precio",
    bias: "neutral",
    when: "Precio plano y el CVD baja.",
    meaning:
      "Vendedores agresivos que no consiguen bajar el precio: alguien compra pasivamente (suelo) o se está distribuyendo. Atento a una ruptura o a una absorción.",
  },
  // ── Agotamiento ──
  {
    id: "exhaustion-up-div",
    title: "Agotamiento alcista sin respaldo",
    bias: "bearish",
    when: "Agotamiento en máximos, el precio sube y el CVD baja.",
    meaning:
      "Nuevo máximo con casi nada de volumen en el extremo y sin flujo comprador: la subida se queda sin combustible. Suele anticipar pausa o giro bajista.",
  },
  {
    id: "exhaustion-up",
    title: "Agotamiento alcista",
    bias: "bearish",
    when: "Agotamiento en máximos reciente.",
    meaning:
      "Nuevo máximo con muy poco volumen en el extremo: los compradores pierden fuerza. Señal de cautela para las compras; espera confirmación de los vendedores.",
  },
  {
    id: "exhaustion-down-reversal",
    title: "Agotamiento vendedor con compras entrando",
    bias: "bullish",
    when: "Agotamiento en mínimos, el precio baja y el CVD sube.",
    meaning:
      "El precio aún cae, pero en el mínimo casi no hay volumen y los compradores agresivos ya entran (CVD sube): la caída se agota. Candidato a giro alcista.",
  },
  {
    id: "exhaustion-down",
    title: "Agotamiento vendedor",
    bias: "bullish",
    when: "Agotamiento en mínimos reciente.",
    meaning:
      "Nuevo mínimo con muy poco volumen en el extremo: los vendedores pierden fuerza. Señal de cautela para las ventas; espera confirmación de los compradores.",
  },
  // ── Absorción ──
  {
    id: "absorption-buy",
    title: "Absorción compradora",
    bias: "bullish",
    when: "Mucho volumen vendedor agresivo en el mínimo de la barra y el precio no baja.",
    meaning:
      "Las ventas agresivas chocan contra compra pasiva grande y no logran bajar el precio. Suele marcar un soporte; más fuerte si el CVD sigue cayendo (los vendedores gastan munición).",
  },
  {
    id: "absorption-sell",
    title: "Absorción vendedora",
    bias: "bearish",
    when: "Mucho volumen comprador agresivo en el máximo de la barra y el precio no sube.",
    meaning:
      "Las compras agresivas chocan contra venta pasiva grande y no logran subir el precio. Suele marcar una resistencia; más fuerte si el CVD sigue subiendo.",
  },
  // ── Desequilibrios apilados ──
  {
    id: "stacked-buy-trend",
    title: "Desequilibrios apilados compradores",
    bias: "bullish",
    when: "Varios niveles seguidos dominados por compradores y el precio sube.",
    meaning:
      "Compra agresiva sostenida en varios niveles consecutivos: suele indicar participación institucional. Esas zonas pueden actuar como soporte en retrocesos.",
  },
  {
    id: "stacked-sell-trend",
    title: "Desequilibrios apilados vendedores",
    bias: "bearish",
    when: "Varios niveles seguidos dominados por vendedores y el precio baja.",
    meaning:
      "Venta agresiva sostenida en varios niveles consecutivos: suele indicar participación institucional. Esas zonas pueden actuar como resistencia en rebotes.",
  },
  {
    id: "stacked-buy-trapped",
    title: "Compras apiladas que no avanzan",
    bias: "neutral",
    when: "Desequilibrios compradores apilados pero el precio no sube.",
    meaning:
      "La compra agresiva no se traduce en precio: está siendo absorbida. Si el precio pierde esa zona, los compradores quedan atrapados.",
  },
  {
    id: "stacked-sell-trapped",
    title: "Ventas apiladas que no avanzan",
    bias: "neutral",
    when: "Desequilibrios vendedores apilados pero el precio no baja.",
    meaning:
      "La venta agresiva no se traduce en precio: está siendo absorbida. Si el precio recupera esa zona, los vendedores quedan atrapados.",
  },
  // ── Divergencias de CVD ──
  {
    id: "cvd-div-bullish",
    title: "Divergencia alcista de CVD",
    bias: "bullish",
    when: "Precio marca un mínimo más bajo pero el CVD uno más alto.",
    meaning: "El precio cae más, pero con menos presión vendedora neta: los vendedores pierden fuerza. Posible suelo o giro alcista.",
  },
  {
    id: "cvd-div-bearish",
    title: "Divergencia bajista de CVD",
    bias: "bearish",
    when: "Precio marca un máximo más alto pero el CVD uno más bajo.",
    meaning: "El precio sube más, pero con menos presión compradora neta: los compradores pierden fuerza. Posible techo o giro bajista.",
  },
  // ── Combinaciones ──
  {
    id: "confluence-bullish",
    title: "Confluencia alcista",
    bias: "bullish",
    when: "Al menos dos señales alcistas distintas y ninguna bajista.",
    meaning: "Varias lecturas independientes del flujo apuntan al mismo lado: más fiable que una señal aislada.",
  },
  {
    id: "confluence-bearish",
    title: "Confluencia bajista",
    bias: "bearish",
    when: "Al menos dos señales bajistas distintas y ninguna alcista.",
    meaning: "Varias lecturas independientes del flujo apuntan al mismo lado: más fiable que una señal aislada.",
  },
  {
    id: "mixed",
    title: "Señales contradictorias",
    bias: "neutral",
    when: "Hay señales alcistas y bajistas recientes a la vez.",
    meaning: "El flujo no se decide: conviene esperar a que un lado se imponga antes de sacar conclusiones.",
  },
] as const satisfies readonly ScenarioDef[];

export type ScenarioId = (typeof SCENARIOS)[number]["id"];

export interface MatchedScenario {
  id: ScenarioId;
  /** importancia 1-3 */
  weight: number;
}

/** Foto del monitor: qué hacen precio y CVD, qué señales hay y qué escenarios aplican ahora. */
export interface MarketSummary {
  time: number;
  price: number;
  /** ventana sobre la que se miden las tendencias */
  lookbackMs: number;
  priceTrend: Trend;
  cvdTrend: Trend;
  priceChange: number;
  cvdChange: number;
  /** delta de la barra en formación */
  barDelta: number;
  /** ids de señales recientes consideradas */
  signalIds: string[];
  /** escenarios activos, el más relevante primero */
  scenarios: MatchedScenario[];
  /** -100 (muy bajista) .. 100 (muy alcista) */
  score: number;
  bias: ScenarioBias;
}

export type AnalysisServerMessage =
  /** `history`: los últimos cambios de lectura (más reciente al final) */
  | { type: "snapshot"; summary: MarketSummary | null; history: MarketSummary[]; upstream: UpstreamState }
  | { type: "summary"; summary: MarketSummary }
  /** el monitor cambió de lectura (bias o conjunto de escenarios) */
  | { type: "change"; summary: MarketSummary }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal polymarket (markets BTC Up/Down 5m) ─────────────────────────

/** Estado de un market: upcoming (aun no empieza) · live · resolving (termino, sin resultado oficial) · closed (con resultado). */
export type PmStatus = "upcoming" | "live" | "resolving" | "closed";

/** Un market "BTC Up or Down" de Polymarket. `start`/`end` en ms (UTC, alineados a 5 min). */
export interface PmMarket {
  slug: string;
  title: string;
  start: number;
  end: number;
  upToken: string;
  downToken: string;
  /** "Price to beat" = precio de apertura (openPrice) segun Polymarket; null hasta que lo publica */
  priceToBeat: number | null;
  /** precio de cierre oficial (null hasta que el market resuelve) */
  closePrice: number | null;
  /** variacion % oficial entre apertura y cierre (null hasta resolver) */
  changePct: number | null;
  status: PmStatus;
  /** resultado oficial segun Polymarket (null hasta que lo publica) */
  result: "up" | "down" | null;
}

/** Muestra de 1 s del market en curso: precios de los tokens en probabilidad 0-1 (mejor bid/ask). */
export interface PmPoint {
  /** reloj de Binance, ms */
  time: number;
  /** precio Chainlink BTC/USD: TWAP de 60 s (o spot si el servidor no tiene credenciales); null hasta el primero */
  chainlink: number | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  /** Ultimo precio de Binance de ese segundo (de la fuente: spot o futures) */
  binance: number | null;
  /** Chainlink (TWAP) - media de 60 s de Binance: pasa el precio de Binance a las "unidades" con que resuelve Polymarket */
  basis: number | null;
  /** Volatilidad realizada del momento, en USD por raiz de segundo */
  sigma: number | null;
  /** Puntuacion de flujo -1 (vendedor) .. 1 (comprador) a partir de senales de footprint y CVD */
  flow: number | null;
  /** Probabilidad de que el market termine Up segun el motor (0-1); null si no se pudo calcular */
  pModel: number | null;
  /**
   * Motores D y E: deriva esperada del precio en USD (unidades Chainlink) en los proximos segundos, predicha con el flujo de
   * Binance (OFI, momentum, desequilibrio del libro). Ausente en A y C.
   */
  drift?: number | null;
}

export type PmSide = "up" | "down";

/**
 * Senal del motor: comprar o vender un token. `price` es el precio ejecutable (ask al comprar, bid al vender).
 * Ver docs/features/signal-engine.md.
 */
export interface PmSignal {
  id: string;
  slug: string;
  /** reloj de Binance, ms */
  time: number;
  action: "buy" | "sell";
  side: PmSide;
  /** entry: abrir · exit: cerrar porque vender vale mas que mantener · flip: comprar el otro lado tras vender · hedge: comprar el otro lado sin vender */
  reason: "entry" | "exit" | "flip" | "hedge";
  price: number;
  /** comision de taker por token */
  fee: number;
  shares: number;
  /** USDC: coste total (con comision) al comprar, ingreso neto al vender */
  amount: number;
  /** probabilidad del motor de que `side` gane */
  pSide: number;
  /** compra: EV por token manteniendo hasta el final · venta: lo que vale mas vender que mantener, por token */
  edge: number;
  /** segundos que faltaban para el cierre del market */
  tau: number;
  /**
   * Motor D (y salidas de emergencia de E): peor precio aceptado (compra: maximo, venta: minimo), calculado para que la
   * operacion siga teniendo EV positivo aunque el precio se mueva mientras Polymarket la registra. Las compras reales lo usan como limite de la orden FAK.
   */
  limit?: number;
  /** Motores D y E (papel realista): precio en el instante de la decision. `price` es entonces el de la ejecucion simulada */
  signalPrice?: number;
  /** Motores D y E: instante de la ejecucion simulada (reloj de Binance, ms) */
  execTime?: number;
  /** Motor E: ejecutada como maker (orden en reposo; sin comision) */
  maker?: boolean;
}

/**
 * Orden en reposo (limite, maker) del motor E en el libro de Polymarket. Simulada con la cola real del libro y los trades de Polymarket.
 * Ver docs/features/predictive-engines.md.
 */
export interface PmOrder {
  id: string;
  slug: string;
  side: PmSide;
  /** buy: entrada (bid en reposo) · sell: salida (ask en reposo) */
  action: "buy" | "sell";
  price: number;
  shares: number;
  /** decision de colocarla, entrada en el libro (tras la latencia de envio) y cancelacion pedida; reloj de Binance, ms */
  placedAt: number;
  liveAt: number;
  cancelAt: number | null;
  /** tokens por delante en la cola al entrar en el libro */
  queueAhead: number;
  filledShares: number;
  /** primera ejecucion */
  filledAt: number | null;
  status: "pending" | "open" | "filled" | "cancelled";
  /** por que se cancelo: edge (ya no compensa) · drift (el flujo se giro) · drop (la probabilidad cayo) · reprice (reposicion) · closing · stop · market */
  cancelReason: PmCancelReason | null;
}

export type PmCancelReason = "edge" | "drift" | "drop" | "reprice" | "closing" | "stop" | "market";

/** Resultado paper de las senales de un market (se asume que se siguen todas). */
export interface PmPnl {
  /** USDC gastados en compras (con comision) */
  invested: number;
  /** USDC netos de las ventas */
  sold: number;
  /** tokens que quedan abiertos al cierre */
  openUp: number;
  openDown: number;
  /** ganancia neta con el resultado oficial: sold + pago de los tokens ganadores - invested; null hasta que el market resuelve */
  net: number | null;
  /** net / invested; null si no se invirtio nada o aun no resuelve */
  roi: number | null;
}

/** Market + todo lo registrado durante su ventana (precio de los tokens y flujo de Binance) para revisarlo despues. */
/**
 * Fila resumen de un market guardado en la base de datos (API HTTP `GET /api/markets`).
 * Lo justo para la tabla del historial; los datos completos (points, barras...) no viajan.
 */
export interface PmMarketRow {
  slug: string;
  /** inicio y fin de la ventana, ms (reloj de Binance) */
  start: number;
  end: number;
  priceToBeat: number | null;
  closePrice: number | null;
  changePct: number | null;
  result: "up" | "down";
  /** suma del delta de las barras footprint de la ventana */
  delta: number;
  /** variacion del CVD entre el primer y el ultimo punto de la ventana */
  cvdChange: number;
  /** senales de footprint alcistas / bajistas */
  bull: number;
  bear: number;
  /** probabilidad implicita de Up (mitad del spread) al inicio y al final; null si no hubo cotizacion */
  upStart: number | null;
  upEnd: number | null;
  /** operaciones (compras+ventas) que dio el motor, y su resultado de papel */
  trades: number;
  invested: number;
  sold: number;
  net: number | null;
  /** resumen por motor (A = los campos trades/invested/sold/net de arriba) */
  engines: Record<PmEngineId, PmEngineSummary>;
  /** versión del motor con que se generó (null en markets anteriores a esa columna) */
  engineVersion: number | null;
  /** los aggTrades guardados cubren la ventana con su margen previo (se puede reconstruir el footprint) */
  tradesOk: boolean;
}

/** Respuesta de `GET /api/markets` */
export interface PmMarketsResponse {
  /** markets guardados en total (sin aplicar from/to/limit) */
  total: number;
  markets: PmMarketRow[];
}

/**
 * Comparativa spot vs futures de un motor en un market guardado por las dos fuentes (`GET /api/compare`).
 * Primera entrada = primera compra con `reason: "entry"`; `time` es el instante de la decision (reloj de Binance).
 */
export interface CompareEngineMarket {
  spot: PmEngineSummary;
  futures: PmEngineSummary;
  /** lado de la primera entrada de cada fuente (null si no entro) */
  spotSide: PmSide | null;
  futuresSide: PmSide | null;
  /** primera entrada de spot - primera entrada de futures, en ms, si las dos entraron por el MISMO lado: > 0 = futures antes */
  leadMs: number | null;
  /** precio de la primera entrada de spot - el de futures (mismo lado): > 0 = futures compro mas barato */
  priceDiff: number | null;
}

export interface CompareMarketRow {
  slug: string;
  start: number;
  result: "up" | "down";
  engines: Record<PmEngineId, CompareEngineMarket>;
}

/** Totales de un motor sobre los markets comparados */
export interface CompareEngineTotals {
  /** markets guardados por las dos fuentes */
  markets: number;
  /** resultado de papel sumado (markets resueltos) e importe invertido */
  spotNet: number;
  futuresNet: number;
  spotInvested: number;
  futuresInvested: number;
  spotTrades: number;
  futuresTrades: number;
  /** markets en que las dos entraron por el mismo lado, y en cuantos futures entro antes / despues */
  sameSide: number;
  futuresFirst: number;
  spotFirst: number;
  /** medias sobre los markets `sameSide` (null si no hay) */
  avgLeadMs: number | null;
  medianLeadMs: number | null;
  avgPriceDiff: number | null;
  /** entradas en un solo lado o en lados distintos */
  onlySpot: number;
  onlyFutures: number;
  oppositeSide: number;
}

/** Respuesta de `GET /api/compare?limit=` */
export interface CompareResponse {
  markets: CompareMarketRow[];
  totals: Record<PmEngineId, CompareEngineTotals>;
  /** false si el servidor no tiene la fuente futures activada */
  futuresEnabled: boolean;
}

/** Resultado de un motor en un market: sus muestras de 1 s ("fotos" con que decidio) y sus operaciones. */
export interface PmEngineRun {
  points: PmPoint[];
  trades: PmSignal[];
  pnl: PmPnl;
  /** motor E: ordenes en reposo colocadas, ejecutadas y canceladas (reposiciones) */
  orders?: PmOrder[];
}

/** Operaciones y resultado de papel de un motor en un market (para la tabla) */
export interface PmEngineSummary {
  trades: number;
  invested: number;
  net: number | null;
}

export interface PmRecord {
  market: PmMarket;
  /** muestras del motor A (segundo exacto, datos en vivo); tambien sirven para el grafico de precios del market */
  points: PmPoint[];
  /** barras footprint de la ventana (las que empiezan dentro de [start, end)) */
  bars: FootprintBar[];
  cvd: CvdPoint[];
  signals: OrderflowSignal[];
  /** senales de compra/venta del motor A durante la ventana */
  trades: PmSignal[];
  pnl: PmPnl;
  /**
   * Motores C, D y E: sus muestras y operaciones. Ausente en markets antiguos. Los markets guardados antes del 26 nov pueden traer
   * tambien `b` (motor B, eliminado): se ignora.
   */
  engines?: Partial<Record<PmSecondaryEngineId, PmEngineRun>>;
  /** true si el servidor tuvo datos de los 5 minutos completos (solo esos se guardan en la base de datos) */
  complete: boolean;
}

export type PolymarketServerMessage =
  | {
      type: "snapshot";
      /** market en curso (null si aun no se conoce) y el siguiente */
      current: PmMarket | null;
      next: PmMarket | null;
      /** muestras del motor A en el market en curso */
      points: PmPoint[];
      /** senales del motor A del market en curso */
      trades: PmSignal[];
      /** muestras y senales de los motores C, D y E en el market en curso (E con sus ordenes) */
      engines: Record<PmSecondaryEngineId, PmLiveRun>;
      /** markets terminados, antiguo -> reciente */
      history: PmRecord[];
      /** cuantos markets terminados guarda el servidor */
      historyMax: number;
      upstream: UpstreamState;
    }
  /** cambio de current/next (rotacion, tokens o resultado recibidos) */
  | { type: "markets"; current: PmMarket | null; next: PmMarket | null }
  /** muestra de 1 s de un motor en el market en curso */
  | { type: "point"; engine: PmEngineId; point: PmPoint }
  /** senal de compra/venta de un motor en el market en curso */
  | { type: "signal"; engine: PmEngineId; signal: PmSignal }
  /** orden en reposo del motor E nueva o actualizada (ejecucion, cancelacion): el cliente hace upsert por `id` */
  | { type: "order"; engine: "e"; order: PmOrder }
  /** market terminado (o su resultado actualizado): el cliente hace upsert por slug */
  | { type: "record"; record: PmRecord }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal engines (decisiones de los motores A, C, D y E) ─────────────────────────

/**
 * a: reglas EV por segundo, en el segundo exacto con lo ultimo recibido ("en vivo").
 * c: mismas reglas que A, el segundo + 150 ms con datos "a fecha" de ese segundo (marca de tiempo <= T).
 * d: predictivo (taker): decide cada 100 ms con la deriva prevista por el flujo de Binance, EV contra el precio esperado al
 *    ejecutar y precio limite; su papel simula la latencia de Polymarket.
 * e: libro (maker): ordenes limite en reposo que se recolocan o cancelan cuando la idea muere; papel con la cola real del libro.
 * Todos se guardan en la base de datos (A en `points`/`trades` del market, el resto en `engines`). El motor B (+300 ms) se elimino.
 */
export type PmEngineId = "a" | "c" | "d" | "e";
/** motores que se guardan en `PmRecord.engines` (A va en `points`/`trades`) */
export type PmSecondaryEngineId = Exclude<PmEngineId, "a">;

/** Muestras, senales y (motor E) ordenes de un motor en el market en curso */
export interface PmLiveRun {
  points: PmPoint[];
  trades: PmSignal[];
  orders?: PmOrder[];
}

/**
 * Por que un lado se compra / vende (ok) o no en ese segundo. Se informa el primer impedimento, en el orden en que el motor los evalua:
 * noData sin datos para el modelo · flat sin posicion (venta) · noQuote sin precio · warmup calentando · closing ultimos segundos ·
 * maxEntries tope de compras · justSold acaba de vender ese lado · spread demasiado ancho · holding ya tiene ese lado ·
 * cooldown espera tras la ultima senal · edge EV por debajo del umbral · stake importe minimo / tope por market ·
 * pending (D/E) orden enviada esperando ejecucion · quoting (E) orden en reposo en el libro · drift (E) el flujo de Binance no acompana.
 */
export type PmBlock =
  | "ok"
  | "noData"
  | "flat"
  | "noQuote"
  | "warmup"
  | "closing"
  | "maxEntries"
  | "justSold"
  | "spread"
  | "holding"
  | "cooldown"
  | "edge"
  | "stake"
  | "pending"
  | "quoting"
  | "drift";

/** Evaluacion de un lado (Up o Down) en un segundo. Edges en USDC por token. */
export interface PmSideDecision {
  /** tokens en cartera antes de decidir */
  shares: number;
  /** P(lado) - coste de compra (ask + comision + deslizamiento); null sin ask */
  buyEdge: number | null;
  buy: PmBlock;
  /** (bid - comision - deslizamiento) - P(lado); solo con posicion */
  sellEdge: number | null;
  sell: PmBlock;
}

/** Registro de una decision de un motor (un segundo): entradas, probabilidades, evaluacion y senales emitidas. */
export interface PmDecision {
  /** reloj de Binance, ms */
  time: number;
  /** segundos hasta el cierre */
  tau: number;
  chainlink: number | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  /** probabilidad de Up: solo el modelo, implicita del mercado, y la mezcla con que decide */
  pModel: number | null;
  pMarket: number | null;
  pUp: number | null;
  up: PmSideDecision;
  down: PmSideDecision;
  /** senales emitidas en este segundo (normalmente ninguna) */
  signals: PmSignal[];
}

/** Umbrales con que decide un motor (A y C comparten los mismos; D y E tienen los suyos en `PmEngineInfo.thresholds`) */
export interface PmEngineThresholds {
  minEdge: number;
  exitMargin: number;
  maxSpread: number;
  warmupS: number;
  noEntryS: number;
}

/** Como decide cada motor */
export interface PmEngineInfo {
  id: PmEngineId;
  /** live: lo ultimo recibido · asOf: datos con marca de tiempo <= segundo · fast: cada `delayMs` ms con lo ultimo recibido (D, E) */
  mode: "live" | "asOf" | "fast";
  /** live/asOf: ms tras el inicio del segundo de Binance en que decide · fast: cada cuantos ms decide */
  delayMs: number;
  /** taker: compra/vende contra el libro · maker: deja ordenes limite en reposo */
  kind: "taker" | "maker";
  /** umbrales propios del motor (A y C comparten los de `thresholds`) */
  thresholds: PmEngineThresholds;
}

export type EnginesServerMessage =
  | {
      type: "snapshot";
      thresholds: PmEngineThresholds;
      engines: PmEngineInfo[];
      /** decisiones del market en curso de cada motor (con su slug), antiguo -> reciente */
      decisions: Record<PmEngineId, { slug: string | null; decisions: PmDecision[] }>;
    }
  /** nueva decision de un motor; si cambia `slug`, empieza un market nuevo (el cliente vacia ese motor) */
  | { type: "decision"; engine: PmEngineId; slug: string; decision: PmDecision };

// ───────────────────────── Canal latency (latencia hacia el CLOB de Polymarket) ─────────────────────────

/**
 * Medidas de una ronda (nunca se opera). Una orden real es firma local + `POST /order` autenticado; el precio no viaja como campo
 * (va implicito en makerAmount/takerAmount) y sale del libro que el servidor ya recibe por WS, asi que `book` es opcional
 * (clob-client solo lo pide por REST si no se le pasa precio).
 * Todo salvo `connect` va por una conexion HTTP/2 persistente y siempre caliente (la de un bot).
 * connect: GET /time con conexion nueva HTTP/1.1 (DNS + TCP + TLS + ida y vuelta) · edge: PING de HTTP/2, lo responde el borde de
 * Cloudflare (red pura, sin Polymarket) · ping: GET /time con la conexion ya abierta ·
 * book: GET /book del token Up del market en curso · auth: GET /balance-allowance autenticado (L2) ·
 * order: POST /order con una orden completa (proxy wallet, token del market, 1 USDC, FOK) y FIRMA DE CEROS: Polymarket la rechaza al
 *   verificar la firma (400 "invalid POLY_PROXY signature"), justo antes del matching. Nunca puede ejecutarse.
 */
export type LatencyProbeId = "connect" | "edge" | "ping" | "book" | "auth" | "order";

export interface LatencyProbe {
  /** ida y vuelta en ms; null si fallo o no se pudo medir */
  ms: number | null;
  /** codigo HTTP de la respuesta (p. ej. 401 en `auth` sin PM_SIGNER_ADDRESS: la latencia sigue siendo la del gateway) */
  status: number | null;
  /** mensaje de Polymarket en la respuesta (p. ej. "invalid POLY_PROXY signature" en `order`) */
  detail?: string;
  /** error de red / timeout */
  error?: string;
}

export interface LatencySample {
  /** inicio de la ronda, reloj de Binance (ms) */
  time: number;
  probes: Record<LatencyProbeId, LatencyProbe>;
  /** ms en preparar la orden al decidir (cuerpo + HMAC de la peticion); sin la firma EIP-712 real */
  prepMs: number | null;
  /** estimacion de una orden con la conexion caliente = prepMs + POST /order (o auth, o ping si fallan); sin firma EIP-712 ni matching */
  estimateMs: number | null;
}

/**
 * Check maker: ordenes MAKER reales (limite post-only, la forma de operar del motor E) que siguen las senales del motor elegido
 * (A, C o D). Con cada compra del motor se deja una compra a mejor bid + 1 tick (primera de la fila; si el spread es de 1 tick,
 * se une al mejor bid) de max(1 USDC, 5 tokens), y se cancela a los `restMs` (2 s) si no se lleno. Las ventas del motor hacen
 * lo mismo en el lado ask con los tokens que se compraron asi. Mide cada paso del ciclo y si se ejecuto. Solo con el interruptor
 * (contrasena de trading), solo en el market en curso; se apaga sola tras `max` ordenes. Tiempos en ms desde el envio.
 * Ver docs/features/latency.md.
 */
export interface MakerProbeSample {
  /** id de la senal del motor que la disparo */
  signalId: string;
  engine: LiveEngine;
  slug: string;
  action: "buy" | "sell";
  side: PmSide;
  /** instante y precio de la senal (ask al comprar, bid al vender), reloj de Binance */
  signalTime: number;
  signalPrice: number;
  /** precio limite de la orden maker y tokens pedidos */
  price: number;
  size: number;
  /** envio de POST /order (reloj de Binance, ms); null si no se envio */
  time: number | null;
  /** firmar la orden en local */
  signMs: number | null;
  /** ida y vuelta de POST /order */
  postMs: number | null;
  postStatus: number | null;
  /** estado que devuelve Polymarket (live = en el libro) */
  orderStatus: string | null;
  orderId: string | null;
  /** llega el evento PLACEMENT por el canal de usuario */
  userAckMs: number | null;
  /** la orden aparece en el libro publico (canal de market; aproximado: cambio de su nivel con su tamano) */
  bookMs: number | null;
  /** primera ejecucion (evento `trade` del canal de usuario) */
  firstFillMs: number | null;
  /** tokens ejecutados */
  filledShares: number;
  /** ida y vuelta de DELETE /order (cancelar); null si se lleno entera antes */
  cancelMs: number | null;
  cancelStatus: number | null;
  /** desde el envio de la cancelacion: evento CANCELLATION del canal de usuario y desaparicion del libro publico */
  userCancelMs: number | null;
  bookGoneMs: number | null;
  /** marca de tiempo de Polymarket de la colocacion / cancelacion menos nuestro envio (incluye el desfase entre relojes) */
  exchangePlaceMs: number | null;
  exchangeCancelMs: number | null;
  /** filled: entera · partial: en parte · unfilled: nada en `restMs` · rejected: Polymarket la rechazo (p. ej. post-only cruzaria) · skipped: no se envio · error */
  status: "filled" | "partial" | "unfilled" | "rejected" | "skipped" | "error";
  /** mensaje de Polymarket o motivo */
  error: string | null;
}

export interface MakerProbeState {
  /** hay clave y contrasena (las mismas que las compras reales) */
  available: boolean;
  reason: string | null;
  enabled: boolean;
  /** motor cuyas senales se siguen */
  engine: LiveEngine;
  /** ordenes enviadas desde que se activo y tope (se apaga sola al llegar) */
  done: number;
  max: number;
  /** tiempo en el libro antes de cancelar (ms) */
  restMs: number;
  /** importe: max(minUsd, minShares tokens); tope de compras por market */
  minUsd: number;
  minShares: number;
  maxMarketUsd: number;
  /** market en curso, USDC gastados y tokens comprados asi en el */
  currentSlug: string | null;
  spentUsd: number;
  position: Record<PmSide, number>;
}

/** POST /api/latency/maker (cabecera `x-trading-password`): activa o desactiva el check maker. Respuesta: `{ state }` o `{ error }` */
export interface MakerProbeRequest {
  enabled: boolean;
  /** por defecto se mantiene el anterior (al arrancar: C) */
  engine?: LiveEngine;
}

export type LatencyServerMessage =
  | {
      type: "snapshot";
      /** cada cuanto mide el servidor (ms) */
      intervalMs: number;
      /** host medido */
      target: string;
      /** desde donde mide el servidor: region de Railway (RAILWAY_REPLICA_REGION) o "local" */
      region: string;
      /** protocolo de la conexion caliente */
      transport: "h2";
      /** true si hay credenciales L2 completas (API key + secret + passphrase + direccion del firmante); si no, auth y order responden 401 */
      authReady: boolean;
      /** rondas recientes, antiguo -> reciente */
      history: LatencySample[];
      historyMax: number;
      upstream: UpstreamState;
      /** check maker: ordenes maker reales siguiendo a un motor (antiguo -> reciente) */
      maker: { state: MakerProbeState; history: MakerProbeSample[] };
    }
  | { type: "sample"; sample: LatencySample }
  | { type: "makerSample"; sample: MakerProbeSample }
  | { type: "makerState"; state: MakerProbeState }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal trading (compras reales del motor C) ─────────────────────────

/**
 * Compras/ventas REALES en Polymarket que siguen al motor elegido (A o C), solo con el interruptor activado y solo en el market
 * en curso (se desactiva solo al terminar el market). Importe proporcional (paper / 5, 1..10 USDC) o el minimo posible; orden FAK.
 * Esta informacion de momento NO se guarda en la base: vive en memoria del servidor.
 */
/** motor cuyas senales se ejecutan: A (T + 0, lo antes posible), C (T + 150 ms) o D (predictivo, con precio limite propio) */
export type LiveEngine = "a" | "c" | "d";
/** scaled: paper / 5 (1..10 USDC) · min: lo minimo que acepta Polymarket y se puede vender despues (max(1 USDC, 5 tokens)) */
export type LiveSizing = "scaled" | "min";
export type LiveTradeStatus =
  /** casada (total o parcialmente) */
  | "matched"
  /** aceptada con retraso de matching (no deberia pasar en BTC 5m) */
  | "delayed"
  /** aceptada sin casar: no habia liquidez dentro del limite */
  | "unmatched"
  /** rechazada por Polymarket */
  | "rejected"
  /** fallo de red / firma / timeout */
  | "error"
  /** no se envio (sin posicion que vender, fuera de limites...) */
  | "skipped";

export interface LiveTrade {
  /** id de la senal que la disparo */
  signalId: string;
  /** motor que la disparo */
  engine: LiveEngine;
  slug: string;
  action: "buy" | "sell";
  side: PmSide;
  reason: PmSignal["reason"];
  /** instante de la senal (segundo de Binance que decidio el motor C), reloj de Binance */
  signalTime: number;
  /** precio de la senal (ask al comprar, bid al vender) */
  signalPrice: number;
  /** importe paper de la senal (USDC) */
  paperAmount: number;
  /** compra: USDC pedidos · venta: null */
  requestedUsd: number | null;
  /** venta: tokens a vender · compra: null */
  requestedShares: number | null;
  /** peor precio aceptado (senal +2c al comprar, -2c al vender) */
  limitPrice: number;
  /** envio de la orden y llegada de la respuesta, reloj de Binance; null si no se envio */
  sentAt: number | null;
  respondedAt: number | null;
  /** ida y vuelta de POST /order (ms) */
  latencyMs: number | null;
  /**
   * instante de la ejecucion segun Polymarket (ms, su reloj; `timestamp` del evento `trade` del canal de usuario). Llega despues
   * de la respuesta: el servidor reenvia la operacion con este campo. null hasta entonces o si no se ejecuto.
   */
  matchedAt: number | null;
  /** firmar la orden en local (ms) */
  signMs: number | null;
  status: LiveTradeStatus;
  filledShares: number;
  /** compra: USDC gastados · venta: USDC recibidos */
  filledUsd: number;
  /** precio medio real (USDC por token); null sin ejecucion */
  avgPrice: number | null;
  /** precio real - precio de la senal, en el sentido desfavorable (+ = peor que la senal); null sin ejecucion */
  slippage: number | null;
  orderId: string | null;
  /** mensaje de Polymarket o del servidor */
  detail: string | null;
}

export interface LiveTradingState {
  /** hay clave privada y contrasena configuradas en el servidor */
  enabled: boolean;
  /** por que esta desactivado (si `enabled` es false) */
  disabledReason: string | null;
  /** market en el que el interruptor esta activado; null = apagado */
  armedSlug: string | null;
  /** motor que se sigue y modo de importe (los elige el usuario al activar) */
  engine: LiveEngine;
  sizing: LiveSizing;
  /** canal de usuario de Polymarket (hora exacta de cada ejecucion) */
  userStream: UpstreamState;
  /** market en curso (el unico que se puede activar) */
  currentSlug: string | null;
  limits: { scale: number; minUsd: number; maxUsd: number; maxMarketUsd: number; slippage: number };
  /** posicion real en el market activado (de las ejecuciones) */
  position: Record<PmSide, { shares: number; costUsd: number }>;
  /** USDC gastados en compras en el market activado */
  spentUsd: number;
}

export type TradingServerMessage =
  | { type: "snapshot"; state: LiveTradingState; trades: LiveTrade[] }
  | { type: "state"; state: LiveTradingState }
  /** operacion real (o intento), nueva o actualizada (p. ej. al llegar `matchedAt`): el cliente hace upsert por `signalId` */
  | { type: "trade"; trade: LiveTrade };

/** POST /api/trading/arm (cabecera `x-trading-password`): activar o desactivar las compras reales en el market en curso. */
export interface TradingArmRequest {
  slug: string;
  armed: boolean;
  /** por defecto se mantiene el anterior (al arrancar: C y proporcional) */
  engine?: LiveEngine;
  sizing?: LiveSizing;
}

// ───────────────────────── Replays: motor A con ejecucion retrasada (GET /api/replays) ─────────────────────────

/**
 * Una orden del motor A ejecutada `delayS` segundos despues de la senal, con el libro de ese instante
 * (ask al comprar, bid al vender). Ver docs/features/replays.md.
 */
export interface PmReplayFill {
  /** segundo en que decidio el motor (reloj de Binance, ms) */
  time: number;
  /** instante de la muestra con que se ejecuto (reloj de Binance, ms); null si no hubo muestra (market ya cerrado) */
  execTime: number | null;
  action: "buy" | "sell";
  side: PmSide;
  reason: PmSignal["reason"];
  /** precio de la senal (ask/bid en T) */
  signalPrice: number;
  /** precio real de la ejecucion retrasada; null si no se ejecuto */
  execPrice: number | null;
  /** tokens comprados / vendidos en la ejecucion (0 si no se ejecuto) */
  shares: number;
  /** USDC: coste con comision al comprar (mismo importe que la senal), ingreso neto al vender */
  amount: number;
  /** filled: ejecutada · missed: sin precio en ese instante (o market cerrado) · noPosition: venta sin tokens (su compra no se ejecuto) */
  status: "filled" | "missed" | "noPosition";
}

/** Resultado del motor A en un market con un retraso dado (0 = ejecucion en el segundo de la senal, como el paper). */
export interface PmReplayRun {
  delayS: number;
  fills: PmReplayFill[];
  pnl: PmPnl;
}

export interface PmReplayMarket {
  slug: string;
  /** inicio y fin de la ventana, ms (reloj de Binance) */
  start: number;
  end: number;
  result: "up" | "down";
  /** generacion de la base de donde salio (v1: motor original; v2: motores A/B/C) */
  generation: "v1" | "v2";
  /** una ejecucion por retraso de `PmReplayReport.delays` (mismo orden) */
  runs: PmReplayRun[];
}

/** Copia de la base (en el bucket R2) usada para el informe */
export interface PmReplaySource {
  generation: "v1" | "v2";
  key: string;
  /** bytes comprimidos */
  size: number;
  /** fecha del objeto en el bucket, ms */
  lastModified: number;
  /** markets que aporto (sin contar los que ya venian de otra copia) */
  markets: number;
}

/** Respuesta de `GET /api/replays`: informe generado con `npm run replays -w @updown/server`. */
export interface PmReplayReport {
  /** siempre "a": se reproduce el motor A sobre las muestras guardadas */
  engine: "a";
  /** retrasos en segundos; 0 es la referencia (ejecucion inmediata) */
  delays: number[];
  sources: PmReplaySource[];
  /** antiguo -> reciente */
  markets: PmReplayMarket[];
}
