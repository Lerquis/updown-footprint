import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { UpstreamState } from "@updown/protocol";

export interface ReconnectingWsEvents {
  message: [unknown];
  state: [UpstreamState];
}

/**
 * WebSocket upstream con reconexion exponencial y, opcionalmente, PING de texto periodico (`pingMs` > 0;
 * lo exigen los streams `ws-live-data` y CLOB de Polymarket; el v2 usa pings de protocolo y no lo necesita).
 * `onOpen` devuelve los mensajes de suscripcion a enviar en cada (re)conexion.
 */
export class ReconnectingWs extends EventEmitter<ReconnectingWsEvents> {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private pinger?: NodeJS.Timeout;
  state: UpstreamState = "connecting";

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly onOpen: () => unknown[],
    private readonly pingMs: number = 5000,
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
    clearInterval(this.pinger);
    this.ws?.removeAllListeners();
    this.ws?.on("error", () => {});
    this.ws?.close();
  }

  /** Envia un mensaje por la conexion abierta (p. ej. la suscripcion tras autenticar). */
  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Cierra la conexion actual; la logica de reconexion exponencial la reabre. */
  reconnect(): void {
    this.ws?.close();
  }

  private setState(s: UpstreamState) {
    this.state = s;
    this.emit("state", s);
  }

  private connect() {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      this.setState("connected");
      console.log(`[${this.name}] connected`);
      for (const m of this.onOpen()) ws.send(JSON.stringify(m));
      clearInterval(this.pinger);
      if (this.pingMs > 0) this.pinger = setInterval(() => ws.readyState === ws.OPEN && ws.send("PING"), this.pingMs);
    });
    ws.on("message", (data) => {
      const text = data.toString();
      if (!text.startsWith("{") && !text.startsWith("[")) return; // PONG u otros textos
      try {
        this.emit("message", JSON.parse(text));
      } catch (err) {
        console.error(`[${this.name}] bad message`, err);
      }
    });
    ws.on("error", (err) => console.error(`[${this.name}] error`, err.message));
    ws.on("close", () => {
      clearInterval(this.pinger);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      this.setState("reconnecting");
      console.warn(`[${this.name}] closed, retry in ${delay}ms`);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }
}
