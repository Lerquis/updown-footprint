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
  pu?: number; // futures: final update id del diff anterior
  b: [string, string][];
  a: [string, string][];
}

interface RawSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

/** Reglas de sincronizacion del libro: spot (`/api/v3`) o futuros USDⓈ-M (`/fapi/v1`), que encadenan los diffs con `pu`. */
export type DepthMode = "spot" | "futures";

/** ¿El diff ya esta contenido en el snapshot (se descarta)? spot: u <= lastUpdateId · futures: u < lastUpdateId */
export function isStaleDiff(mode: DepthMode, d: Pick<RawDepthDiff, "u">, lastUpdateId: number): boolean {
  return mode === "spot" ? d.u <= lastUpdateId : d.u < lastUpdateId;
}

/**
 * ¿Se puede aplicar el diff? (funcion pura; false => hay hueco y hay que resincronizar)
 *  - primero tras el snapshot: spot U <= lastUpdateId + 1 <= u · futures U <= lastUpdateId <= u
 *  - siguientes: spot U == u anterior + 1 · futures pu == u anterior
 */
export function bridgesDiff(mode: DepthMode, d: Pick<RawDepthDiff, "U" | "u" | "pu">, prevU: number, lastUpdateId: number): boolean {
  if (prevU === 0) return mode === "spot" ? d.U <= lastUpdateId + 1 && d.u >= lastUpdateId + 1 : d.U <= lastUpdateId && d.u >= lastUpdateId;
  return mode === "spot" ? d.U === prevU + 1 : d.pu === prevU;
}

export interface DepthClientEvents {
  state: [UpstreamState];
}

/**
 * Mantiene un OrderBook local sincronizado con Binance siguiendo el procedimiento oficial:
 * 1) abrir stream de diffs y bufferizar, 2) pedir snapshot REST, 3) descartar diffs viejos,
 * 4) aplicar en orden verificando continuidad (`bridgesDiff`: spot U == prev.u + 1, futuros pu == prev.u); si hay hueco => resync.
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
    private readonly mode: DepthMode = "spot",
    /** prefijo de los logs (p. ej. "futures:depth") */
    private readonly tag = "depth",
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
      console.log(`[${this.tag}] connected ${url}`);
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
    ws.on("error", (err) => console.error(`[${this.tag}] error`, err.message));
    ws.on("close", () => {
      if (this.stopped || ws !== this.ws) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    this.synced = false;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.setState("reconnecting");
    console.warn(`[${this.tag}] closed, retry in ${delay}ms`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private async loadSnapshot(ws: WebSocket) {
    try {
      const res = await fetch(`${this.restUrl}/depth?symbol=${this.symbol.toUpperCase()}&limit=${this.snapshotLimit}`);
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const snap = (await res.json()) as RawSnapshot;
      if (ws !== this.ws) return; // se reconecto mientras tanto

      this.book.reset(snap.lastUpdateId, snap);
      const pending = this.buffered.filter((d) => !isStaleDiff(this.mode, d, snap.lastUpdateId));
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
        console.log(`[${this.tag}] book synced (lastUpdateId ${snap.lastUpdateId})`);
      }
    } catch (err) {
      console.error(`[${this.tag}] snapshot failed`, (err as Error).message);
      ws.terminate();
    }
  }

  private applyDiff(d: RawDepthDiff, ws: WebSocket) {
    if (!bridgesDiff(this.mode, d, this.prevU, this.book.lastUpdateId)) {
      console.warn(`[${this.tag}] ${this.prevU === 0 ? "first diff does not bridge snapshot" : "gap in diffs"}, resync`);
      this.synced = false;
      ws.terminate();
      return;
    }
    this.prevU = d.u;
    this.lastEventTime = d.E;
    this.book.apply({ bids: d.b, asks: d.a });
  }
}
