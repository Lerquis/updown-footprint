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

/**
 * Cliente upstream hacia Binance con reconexion exponencial. Emite `trade` y `state`.
 * Vigilante: si la conexion esta abierta pero no llega ningun trade en `staleMs` (BTC opera varias veces por segundo), se
 * avisa y se reconecta. Asi se detecto que Binance movio el aggTrade de futuros de /ws a /market/ws (conectaba sin enviar nada).
 */
export class AggTradeClient extends EventEmitter<AggTradeClientEvents> {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  state: UpstreamState = "connecting";

  constructor(
    private readonly baseUrl: string,
    private readonly symbol: string,
    /** prefijo de los logs (p. ej. "futures:binance") */
    private readonly tag = "binance",
    private readonly staleMs = 30_000,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private lastMsg = 0;
  private watchdog?: NodeJS.Timeout;

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
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
      this.lastMsg = Date.now();
      this.setState("connected");
      console.log(`[${this.tag}] connected ${url}`);
      clearInterval(this.watchdog);
      this.watchdog = setInterval(() => {
        if (ws !== this.ws || Date.now() - this.lastMsg < this.staleMs) return;
        console.warn(`[${this.tag}] sin trades en ${this.staleMs / 1000}s con la conexion abierta (${url}): reconectando`);
        clearInterval(this.watchdog);
        ws.terminate();
      }, 5000);
    });
    ws.on("message", (data) => {
      this.lastMsg = Date.now();
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
        console.error(`[${this.tag}] bad message`, err);
      }
    });
    ws.on("error", (err) => console.error(`[${this.tag}] error`, err.message));
    ws.on("close", () => {
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      this.setState("reconnecting");
      console.warn(`[${this.tag}] closed, retry in ${delay}ms`);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }
}
