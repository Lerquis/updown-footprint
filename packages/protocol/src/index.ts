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
} as const;

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
  /** Ultimo precio de Binance (spot) de ese segundo */
  binance: number | null;
  /** Chainlink (TWAP) - media de 60 s de Binance: pasa el precio de Binance a las "unidades" con que resuelve Polymarket */
  basis: number | null;
  /** Volatilidad realizada del momento, en USD por raiz de segundo */
  sigma: number | null;
  /** Puntuacion de flujo -1 (vendedor) .. 1 (comprador) a partir de senales de footprint y CVD */
  flow: number | null;
  /** Probabilidad de que el market termine Up segun el motor (0-1); null si no se pudo calcular */
  pModel: number | null;
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
}

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

export interface PmRecord {
  market: PmMarket;
  points: PmPoint[];
  /** barras footprint de la ventana (las que empiezan dentro de [start, end)) */
  bars: FootprintBar[];
  cvd: CvdPoint[];
  signals: OrderflowSignal[];
  /** senales de compra/venta del motor durante la ventana */
  trades: PmSignal[];
  pnl: PmPnl;
  /** true si el servidor tuvo datos de los 5 minutos completos (solo esos se guardan en la base de datos) */
  complete: boolean;
}

export type PolymarketServerMessage =
  | {
      type: "snapshot";
      /** market en curso (null si aun no se conoce) y el siguiente */
      current: PmMarket | null;
      next: PmMarket | null;
      /** muestras del market en curso */
      points: PmPoint[];
      /** senales del motor del market en curso */
      trades: PmSignal[];
      /** markets terminados, antiguo -> reciente */
      history: PmRecord[];
      /** cuantos markets terminados guarda el servidor */
      historyMax: number;
      upstream: UpstreamState;
    }
  /** cambio de current/next (rotacion, tokens o resultado recibidos) */
  | { type: "markets"; current: PmMarket | null; next: PmMarket | null }
  | { type: "point"; point: PmPoint }
  /** senal de compra/venta del motor en el market en curso */
  | { type: "signal"; signal: PmSignal }
  /** market terminado (o su resultado actualizado): el cliente hace upsert por slug */
  | { type: "record"; record: PmRecord }
  | { type: "status"; upstream: UpstreamState };

// ───────────────────────── Canal engines (decisiones de los motores A y B) ─────────────────────────

/**
 * a: motor principal (muestrea con el reloj interno del servidor; es el que se guarda en la base de datos).
 * b: motor sincronizado (mismas reglas; decide en el segundo exacto del reloj de Binance con datos "a fecha"
 *    de ese segundo, para que servidores distintos tomen las mismas decisiones). Solo en memoria.
 */
export type PmEngineId = "a" | "b";

/**
 * Por que un lado se compra / vende (ok) o no en ese segundo. Se informa el primer impedimento, en el orden en que el motor los evalua:
 * noData sin datos para el modelo · flat sin posicion (venta) · noQuote sin precio · warmup calentando · closing ultimos segundos ·
 * maxEntries tope de compras · justSold acaba de vender ese lado · spread demasiado ancho · holding ya tiene ese lado ·
 * cooldown espera tras la ultima senal · edge EV por debajo del umbral · stake importe minimo / tope por market.
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
  | "stake";

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

/** Umbrales con que deciden ambos motores (para leer las decisiones) */
export interface PmEngineThresholds {
  minEdge: number;
  exitMargin: number;
  maxSpread: number;
  warmupS: number;
  noEntryS: number;
}

/** Operaciones del motor B en un market ya terminado (en memoria del servidor; no se guardan en la base) */
export interface PmEngineMarket {
  slug: string;
  trades: PmSignal[];
}

export type EnginesServerMessage =
  | {
      type: "snapshot";
      /** market en curso de cada motor (null hasta el primero) */
      slug: string | null;
      thresholds: PmEngineThresholds;
      /** retraso (ms) tras cada segundo de Binance con que decide el motor B */
      syncDelayMs: number;
      /** decisiones del market en curso, antiguo -> reciente */
      a: PmDecision[];
      b: PmDecision[];
      /** operaciones del motor B en los ultimos markets terminados, antiguo -> reciente */
      bHistory: PmEngineMarket[];
    }
  /** nueva decision de un motor; si cambia `slug`, empieza un market nuevo (el cliente vacia ese motor) */
  | { type: "decision"; engine: PmEngineId; slug: string; decision: PmDecision }
  /** el motor B termino un market (para su historial) */
  | { type: "bMarket"; market: PmEngineMarket };
