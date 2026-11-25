import { EventEmitter } from "node:events";
import type { UpstreamState } from "@updown/protocol";
import { ReconnectingWs } from "./reconnectingWs.js";

export interface ChainlinkEvents {
  /** ultimo precio Chainlink BTC/USD */
  price: [{ time: number; value: number }];
  state: [UpstreamState];
}

interface RawChainlink {
  payload?: {
    value?: number;
    timestamp?: number;
    /** al suscribirse llega un lote con el historial reciente */
    data?: { value: number; timestamp: number }[];
  };
}

/**
 * Precio Chainlink BTC/USD via el stream en vivo de Polymarket. Solo se suscribe al topic
 * `crypto_prices_chainlink` (ni `activity` ni `comments`: no se usan).
 */
export class ChainlinkClient extends EventEmitter<ChainlinkEvents> {
  private readonly ws: ReconnectingWs;

  constructor(url: string, symbol = "btc/usd") {
    super();
    this.ws = new ReconnectingWs("chainlink", url, () => [
      {
        action: "subscribe",
        subscriptions: [{ topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol }) }],
      },
    ]);
    this.ws.on("state", (s) => this.emit("state", s));
    this.ws.on("message", (m) => {
      const p = (m as RawChainlink).payload;
      if (!p) return;
      if (Array.isArray(p.data)) {
        const last = p.data[p.data.length - 1];
        if (last) this.emit("price", { time: last.timestamp, value: last.value });
      } else if (typeof p.value === "number" && typeof p.timestamp === "number") {
        this.emit("price", { time: p.timestamp, value: p.value });
      }
    });
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
