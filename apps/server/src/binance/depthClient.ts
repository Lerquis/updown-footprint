import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { UpstreamState } from "@updown/protocol";
import type { OrderBook } from "../store/orderBook.js";

/** Evento diff del stream <symbol>@depth@100ms */
interface RawDepthDiff {
  e: "depthUpdate";
  E: number; // event time (reloj de Binance)
  U: number; // first update id
  u: number; // final update id
  b: [string, string][];
  a: [string, string][];
}

interface RawSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface DepthClientEvents {
  state: [UpstreamState];
}

/**
 * Mantiene un OrderBook local sincronizado con Binance siguiendo el procedimiento oficial:
 * 1) abrir stream de diffs y bufferizar, 2) pedir snapshot REST, 3) descartar diffs viejos,
 * 4) aplicar en orden verificando continuidad (U == prev.u + 1); si hay hueco => resync.
 */
export class DepthClient extends EventEmitter<DepthClientEvents> {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private synced = false;
  private buffered: RawDepthDiff[] = [];
  private prevU = 0;
  /** Hora (reloj de Binance) del ultimo diff aplicado; se usa para estampar las columnas. */
  lastEventTime = 0;
  state: UpstreamState = "connecting";

  constructor(
    private readonly wsUrl: string,
    private readonly restUrl: string,
    private readonly symbol: string,
    private readonly book: OrderBook,
    private readonly snapshotLimit: number,
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
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  private connect() {
    this.synced = false;
    this.buffered = [];
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const url = `${this.wsUrl}/${this.symbol}@depth@100ms`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[depth] connected ${url}`);
      void this.loadSnapshot(ws);
    });
    ws.on("message", (data) => {
      let m: RawDepthDiff;
      try {
        m = JSON.parse(data.toString()) as RawDepthDiff;
      } catch {
        return;
      }
      if (m.e !== "depthUpdate") return;
      if (!this.synced) this.buffered.push(m);
      else this.applyDiff(m, ws);
    });
    ws.on("error", (err) => console.error("[depth] error", err.message));
    ws.on("close", () => {
      if (this.stopped || ws !== this.ws) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    this.synced = false;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.setState("reconnecting");
    console.warn(`[depth] closed, retry in ${delay}ms`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private async loadSnapshot(ws: WebSocket) {
    try {
      const res = await fetch(`${this.restUrl}/depth?symbol=${this.symbol.toUpperCase()}&limit=${this.snapshotLimit}`);
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const snap = (await res.json()) as RawSnapshot;
      if (ws !== this.ws) return; // se reconecto mientras tanto

      this.book.reset(snap.lastUpdateId, snap);
      const pending = this.buffered.filter((d) => d.u > snap.lastUpdateId);
      this.buffered = [];
      this.prevU = 0;
      this.synced = true;
      for (const d of pending) {
        if (!this.synced) break;
        this.applyDiff(d, ws);
      }
      if (this.synced) {
        this.attempt = 0;
        this.setState("connected");
        console.log(`[depth] book synced (lastUpdateId ${snap.lastUpdateId})`);
      }
    } catch (err) {
      console.error("[depth] snapshot failed", (err as Error).message);
      ws.terminate();
    }
  }

  private applyDiff(d: RawDepthDiff, ws: WebSocket) {
    if (this.prevU === 0) {
      // primer diff tras el snapshot: debe cubrir lastUpdateId + 1
      if (!(d.U <= this.book.lastUpdateId + 1 && d.u >= this.book.lastUpdateId + 1)) {
        console.warn("[depth] first diff does not bridge snapshot, resync");
        this.synced = false;
        ws.terminate();
        return;
      }
    } else if (d.U !== this.prevU + 1) {
      console.warn("[depth] gap in diffs, resync");
      this.synced = false;
      ws.terminate();
      return;
    }
    this.prevU = d.u;
    this.lastEventTime = d.E;
    this.book.apply({ bids: d.b, asks: d.a });
  }
}
