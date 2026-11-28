import { CHANNELS, type LatencyProbeId } from "@updown/protocol";

/**
 * Mercado de predicción que muestra un panel de markets: mismos motores, mismos mensajes, misma gráfica y mismas compras reales;
 * cambian las rutas y los textos. Ver docs/features/predict-markets.md.
 */
export type Venue = "polymarket" | "predict";

export interface VenueInfo {
  /** titulo del panel para un activo (`BTC`, `ETH`) */
  title: (ticker: string) => string;
  /** etiqueta del estado del enlace */
  badge: string;
  channel: string;
  enginesChannel: string;
  /** API de markets guardados (`/api/markets` o `/api/predict/markets`) */
  api: string;
  /** compras reales disponibles */
  trading: boolean;
  /** etiqueta del precio Chainlink: TWAP en Polymarket, precio puntual en Predict */
  chainlinkLabel: (ticker: string) => string;
  /** título de la franja de Chainlink de la gráfica */
  chainTitle: string;
  /** compras reales: canal, interruptor y textos */
  tradingChannel: string;
  armApi: string;
  currency: "USDC" | "USDT";
  /** importe mínimo que acepta el mercado (texto del modo "Mínimo") */
  minText: string;
  /** tipo de orden (texto del resumen) */
  orderText: (slippage: number) => string;
  /** latencia a la API de órdenes */
  latencyChannel: string;
  latencyTitle: string;
  latencyDesc: string;
  /** textos de las sondas que cambian respecto a Polymarket */
  probes?: Partial<Record<LatencyProbeId, { label: string; help: string }>>;
  /** aviso cuando auth y order responden 401 */
  noAuthText: string;
}

export const VENUES: Record<Venue, VenueInfo> = {
  polymarket: {
    title: (t) => `Polymarket · ${t} Up or Down 5m`,
    badge: "Polymarket",
    channel: CHANNELS.polymarket,
    enginesChannel: CHANNELS.engines,
    api: "/api/markets",
    trading: true,
    chainlinkLabel: (t) => `Chainlink ${t}/USD`,
    chainTitle: "Precio Chainlink (USD, fuente de Polymarket) con señales",
    tradingChannel: CHANNELS.trading,
    armApi: "/api/trading/arm",
    currency: "USDC",
    minText: "máx(1 USDC, 5 tokens)",
    orderText: (sl) => `orden FAK ${sl >= 0.98 ? "sin límite de precio" : `con límite señal ±${Math.round(sl * 100)}¢`}`,
    latencyChannel: CHANNELS.latency,
    latencyTitle: "Latencia a Polymarket",
    latencyDesc: "Cuánto tardaría aproximadamente una compra/venta desde el servidor hasta el CLOB. Se envía una orden real firmada con ceros: Polymarket la rechaza siempre, nunca compra. No incluye el tiempo de matching.",
    noAuthText: "Falta PM_SIGNER_ADDRESS en el servidor: el GET autenticado y POST /order responden 401 antes de validar la orden. La latencia sigue siendo la del gateway; con la dirección, POST /order llega hasta la validación (400) y da la medida exacta.",
  },
  predict: {
    title: (t) => `Predict.fun · ${t} Up/Down 5m`,
    badge: "Predict",
    channel: CHANNELS.predict,
    enginesChannel: CHANNELS.predictEngines,
    api: "/api/predict/markets",
    trading: true,
    chainlinkLabel: (t) => `Chainlink ${t}/USD (precio)`,
    chainTitle: "Precio Chainlink (USD, precio puntual con que resuelve Predict) con señales",
    tradingChannel: CHANNELS.predictTrading,
    armApi: "/api/predict/trading/arm",
    currency: "USDT",
    minText: "1 USDT, el mínimo de Predict",
    orderText: (sl) => `orden de mercado con deslizamiento máx. ${(sl * 100).toFixed(1)} %`,
    latencyChannel: CHANNELS.predictLatency,
    latencyTitle: "Latencia a Predict",
    latencyDesc: "Cuánto tardaría aproximadamente una compra/venta desde el servidor hasta la API de órdenes de Predict. Se envía una orden firmada con ceros, que expira antes del mínimo y es post-only a 0,01: Predict la rechaza siempre, nunca compra. No incluye el matching ni la liquidación on-chain.",
    probes: {
      ping: { label: "Ping", help: "GET /v1/auth/message por la conexión HTTP/2 abierta: red + ida y vuelta Cloudflare ↔ servidores de Predict" },
      connect: { label: "Conexión nueva", help: "GET /v1/auth/message abriendo conexión (DNS + TCP + TLS + ida y vuelta). El servidor mantiene la conexión abierta, así que no se paga" },
      book: { label: "Libro (REST)", help: "GET /v1/markets/{id}/orderbook. Informativo: los motores ya tienen el libro por WebSocket" },
      auth: { label: "GET autenticado", help: "GET /v1/orders con el JWT de la cuenta (mismo gateway que POST /v1/orders). Sin sesión iniciada responde 401" },
      order: { label: "POST /v1/orders", help: "Orden completa firmada con ceros, que expira en 30 s y es post-only a 0,01: Predict la rechaza siempre. Sin sesión iniciada responde 401 en el gateway" },
    },
    noAuthText: "Sin sesión en Predict: el GET autenticado y POST /v1/orders responden 401 en el gateway. La sesión (JWT) se inicia al activar las compras reales; desde entonces la orden de prueba llega hasta la validación y da la medida exacta.",
  },
};
