import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AggTrade, UpstreamState } from "@updown/protocol";

/** Payload crudo de Binance <symbol>@aggTrade */
interface RawAggTrade {
  e: "aggTrade";
  s: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export interface AggTradeClientEvents {
  trade: [AggTrade];
  state: [UpstreamState];
}

/** Cliente upstream hacia Binance con reconexion exponencial. Emite `trade` y `state`. */
export class AggTradeClient extends EventEmitter<AggTradeClientEvents> {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  state: UpstreamState = "connecting";

  constructor(
    private readonly baseUrl: string,
    private readonly symbol: string,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private setState(s: UpstreamState) {
    this.state = s;
    this.emit("state", s);
  }

  private connect() {
    const url = `${this.baseUrl}/${this.symbol}@aggTrade`;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.setState("connected");
      console.log(`[binance] connected ${url}`);
    });
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString()) as RawAggTrade;
        if (m.e !== "aggTrade") return;
        this.emit("trade", {
          id: m.a,
          symbol: m.s,
          price: Number(m.p),
          quantity: Number(m.q),
          time: m.T,
          isBuyerMaker: m.m,
        });
      } catch (err) {
        console.error("[binance] bad message", err);
      }
    });
    ws.on("error", (err) => console.error("[binance] error", err.message));
    ws.on("close", () => {
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      this.setState("reconnecting");
      console.warn(`[binance] closed, retry in ${delay}ms`);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }
}
