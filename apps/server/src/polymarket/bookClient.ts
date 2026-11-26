import { EventEmitter } from "node:events";
import type { UpstreamState } from "@updown/protocol";
import { ReconnectingWs } from "./reconnectingWs.js";

export interface BookEvents {
  /** mejor bid/ask de un token (probabilidad 0-1) */
  /** `time`: marca de tiempo del mensaje de Polymarket (ms), null si no viene */
  quote: [{ token: string; bid: number | null; ask: number | null; time: number | null }];
  state: [UpstreamState];
}

interface Level {
  price: string;
  size: string;
}
interface RawEvent {
  event_type?: string;
  asset_id?: string;
  timestamp?: string | number;
  bids?: Level[];
  asks?: Level[];
  price_changes?: { asset_id: string; best_bid?: string; best_ask?: string }[];
}

const n = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));

/** Mejores precios de compra/venta de los tokens Up/Down de UN market (se crea uno por market). */
export class BookClient extends EventEmitter<BookEvents> {
  private readonly ws: ReconnectingWs;

  constructor(url: string, tokens: string[]) {
    super();
    this.ws = new ReconnectingWs("pm-book", url, () => [{ type: "markets", assets_ids: tokens }], 8000);
    this.ws.on("state", (s) => this.emit("state", s));
    this.ws.on("message", (m) => {
      for (const ev of (Array.isArray(m) ? m : [m]) as RawEvent[]) this.handle(ev);
    });
  }

  private handle(ev: RawEvent) {
    const ts = Number(ev.timestamp);
    const time = Number.isFinite(ts) && ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : null;
    if (ev.event_type === "book" && ev.asset_id) {
      const bid = ev.bids?.length ? Math.max(...ev.bids.map((l) => Number(l.price))) : null;
      const ask = ev.asks?.length ? Math.min(...ev.asks.map((l) => Number(l.price))) : null;
      this.emit("quote", { token: ev.asset_id, bid, ask, time });
    } else if (ev.event_type === "price_change" && ev.price_changes) {
      for (const c of ev.price_changes) this.emit("quote", { token: c.asset_id, bid: n(c.best_bid), ask: n(c.best_ask), time });
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
