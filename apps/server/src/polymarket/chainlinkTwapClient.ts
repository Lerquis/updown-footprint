import { EventEmitter } from "node:events";
import type { UpstreamState } from "@updown/protocol";
import type { ChainlinkEvents } from "./chainlinkClient.js";
import { ReconnectingWs } from "./reconnectingWs.js";

export interface PolyBoltCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

interface RawMsg {
  op?: string;
  code?: string;
  channel?: string;
  snapshot?: boolean;
  payload?: {
    value?: number;
    timestamp?: number;
    /** snapshot inicial: ultimos ~2 min */
    data?: { value: number; timestamp: number }[];
  };
}

/**
 * TWAP de 60 s de Chainlink via PolyBolt (`wss://ws-live-v2.polymarket.com/ws`), el mismo calculo con
 * que Polymarket resuelve los markets. Requiere credenciales CLOB (`auth`); el estado pasa a
 * `connected` solo cuando el servidor confirma `authed` y la suscripcion. Mismos eventos que `ChainlinkClient`.
 */
export class ChainlinkTwapClient extends EventEmitter<ChainlinkEvents> {
  private readonly ws: ReconnectingWs;
  state: UpstreamState = "connecting";
  private halted = false;
  private retry?: NodeJS.Timeout;

  constructor(
    url: string,
    creds: PolyBoltCredentials,
    private readonly symbol = "btcusd",
    private readonly windowSeconds = 60,
    private readonly name = "chainlink-twap",
  ) {
    super();
    // pingMs = 0: el servidor manda pings de protocolo; no hay PING de texto.
    this.ws = new ReconnectingWs(name, url, () => [{ op: "auth", rid: "a1", auth: creds }], 0);
    this.ws.on("state", (s) => {
      // "connected" del socket aun no significa autenticado: esperamos a la suscripcion
      this.setState(s === "connected" ? "connecting" : s);
    });
    this.ws.on("message", (m) => this.handle(m as RawMsg));
  }

  private setState(s: UpstreamState) {
    if (s === this.state) return;
    this.state = s;
    this.emit("state", s);
  }

  private handle(m: RawMsg) {
    if (m.op === "authed") {
      this.ws.send({
        op: "subscribe",
        rid: "s1",
        subscriptions: [{ channel: "price.crypto.twap", filter: { symbol: this.symbol, window_seconds: this.windowSeconds, provider: "chainlink" } }],
      });
    } else if (m.op === "subscribed") {
      this.setState("connected");
    } else if (m.op === "error") {
      // nunca se loguean las credenciales; solo el codigo del servidor
      console.error(`[${this.name}] server error: ${m.code ?? "unknown"}`);
      // Credenciales/ticket rechazados: reintentar cada segundo no sirve; se espera 30 s antes de volver a probar.
      this.setState("reconnecting");
      this.ws.stop();
      this.retry = setTimeout(() => !this.halted && this.ws.start(), 30_000);
    } else if (m.channel === "price.crypto.twap" && m.payload) {
      const p = m.payload;
      if (Array.isArray(p.data)) {
        const last = p.data[p.data.length - 1];
        if (last) this.emit("price", { time: last.timestamp, value: last.value });
      } else if (typeof p.value === "number" && typeof p.timestamp === "number") {
        this.emit("price", { time: p.timestamp, value: p.value });
      }
    }
  }

  start(): void {
    this.halted = false;
    this.ws.start();
  }
  stop(): void {
    this.halted = true;
    clearTimeout(this.retry);
    this.ws.stop();
  }
}
