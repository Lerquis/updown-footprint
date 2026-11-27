import { EventEmitter } from "node:events";
import type { UpstreamState } from "@updown/protocol";
import type { Level } from "../polymarket/pmBook.js";
import { ReconnectingWs } from "../polymarket/reconnectingWs.js";
import { levels } from "./model.js";

export interface PredictWsEvents {
  /** precio Chainlink del feed (`time` = publishTime del oraculo, ms); deduplicado (Predict manda cada valor dos veces) */
  price: [{ time: number; value: number }];
  /** libro completo del outcome Up de un market (Predict manda el libro entero en cada mensaje) */
  orderbook: [{ marketId: number; bids: Level[]; asks: Level[]; time: number | null }];
  /** evento de una orden de la wallet (`predictWalletEvents/{jwt}`): orderAccepted, orderTransactionSuccess, ... */
  wallet: [Record<string, unknown>];
  /** una suscripcion fue rechazada (p. ej. JWT caducado: `invalid_credentials`) */
  rejected: [{ topic: string; code: string }];
  state: [UpstreamState];
}

interface RawMsg {
  type?: string;
  topic?: string;
  requestId?: number;
  success?: boolean;
  error?: { code?: string };
  data?: unknown;
}

/**
 * WebSocket publico de Predict.fun (`wss://ws.predict.fun/ws`, no necesita API key). Topics que se usan:
 * `chainlinkAssetPriceUpdate/{feed}` (no documentado; 1 = BTC) y `predictOrderbook/{marketId}`.
 * Responde el heartbeat (cada 15 s; si no se devuelve, el servidor cierra) y reconecta ante el aviso `system` de reinicio.
 * Las suscripciones se rehacen en cada reconexion. Con `priceFeedId` null no se suscribe al precio (cliente de libro).
 * Expone la misma interfaz que el cliente Chainlink de Polymarket (`price`, `state`, `start`, `stop`).
 */
export class PredictWs extends EventEmitter<PredictWsEvents> {
  private readonly ws: ReconnectingWs;
  private readonly topics = new Set<string>();
  private reqId = 0;
  /** topic de cada peticion en curso (para avisar de rechazos) */
  private pending = new Map<number, string>();
  private lastPublish = 0;

  constructor(name: string, url: string, private readonly priceFeedId: number | null) {
    super();
    if (priceFeedId !== null) this.topics.add(`chainlinkAssetPriceUpdate/${priceFeedId}`);
    // pingMs 0: Predict no usa PING de texto sino su propio heartbeat
    this.ws = new ReconnectingWs(name, url, () => [...this.topics].map((t) => this.req("subscribe", t)), 0);
    this.ws.on("state", (s) => {
      if (s !== "connected") this.lastPublish = 0;
      this.emit("state", s);
    });
    this.ws.on("message", (m) => this.handle(m as RawMsg, name));
  }

  private req(method: "subscribe" | "unsubscribe", topic: string) {
    const requestId = ++this.reqId;
    if (method === "subscribe") this.pending.set(requestId, topic);
    if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
    return { requestId, method, params: [topic] };
  }

  /** Deja de seguir un topic */
  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    this.ws.send(this.req("unsubscribe", topic));
  }

  /** Suscribe un topic (y lo rehace en cada reconexion) */
  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    this.ws.send(this.req("subscribe", topic));
  }

  private handle(m: RawMsg, name: string) {
    if (m.type === "R") {
      const topic = m.requestId !== undefined ? this.pending.get(m.requestId) : undefined;
      if (m.requestId !== undefined) this.pending.delete(m.requestId);
      if (m.success === false) {
        // el topic de la wallet lleva el JWT: no se escribe en el log
        console.warn(`[${name}] peticion ${m.requestId} rechazada: ${m.error?.code ?? "?"}`);
        if (topic) this.emit("rejected", { topic, code: m.error?.code ?? "?" });
      }
      return;
    }
    if (m.type !== "M" || !m.topic) return;
    if (m.topic === "heartbeat") {
      this.ws.send({ method: "heartbeat", data: m.data });
      return;
    }
    if (m.topic === "system") {
      // aviso de reinicio del servidor: abrir una conexion nueva (la reconexion rehace las suscripciones)
      console.warn(`[${name}] aviso de reinicio del servidor: reconectando`);
      this.ws.reconnect();
      return;
    }
    const [topic, param] = m.topic.split("/");
    const d = (m.data ?? {}) as Record<string, unknown>;
    if (topic === "chainlinkAssetPriceUpdate") {
      const price = d.price;
      const t = d.publishTime ?? d.timestamp;
      if (typeof price !== "number" || typeof t !== "number" || !Number.isFinite(price)) return;
      const time = t < 1e12 ? t * 1000 : t;
      if (time <= this.lastPublish) return; // duplicado o desordenado
      this.lastPublish = time;
      this.emit("price", { time, value: price });
    } else if (topic === "predictWalletEvents") {
      this.emit("wallet", d);
    } else if (topic === "predictOrderbook") {
      const marketId = Number(d.marketId ?? param);
      if (!Number.isFinite(marketId)) return;
      const time = typeof d.updateTimestampMs === "number" ? d.updateTimestampMs : null;
      this.emit("orderbook", { marketId, bids: levels(d.bids), asks: levels(d.asks), time });
    }
  }

  get state(): UpstreamState {
    return this.ws.state;
  }
  start(): void {
    this.ws.start();
  }
  stop(): void {
    this.ws.stop();
  }
}
