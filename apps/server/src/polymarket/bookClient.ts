import { EventEmitter } from "node:events";
import type { UpstreamState } from "@updown/protocol";
import type { Level, PmTrade } from "./pmBook.js";
import { ReconnectingWs } from "./reconnectingWs.js";

export interface BookEvents {
  /** mejor bid/ask de un token (probabilidad 0-1); `time`: marca de tiempo del mensaje de Polymarket (ms), null si no viene */
  quote: [{ token: string; bid: number | null; ask: number | null; time: number | null }];
  /** libro completo de un token (al suscribirse y tras cada reconexion) */
  book: [{ token: string; bids: Level[]; asks: Level[]; time: number | null }];
  /** nuevo tamano total de un nivel (0 = desaparece) */
  level: [{ token: string; side: "bid" | "ask"; price: number; size: number; time: number | null }];
  /** trade ejecutado en un token (lado del taker) */
  trade: [PmTrade];
  state: [UpstreamState];
}

interface RawLevel {
  price: string;
  size: string;
}
interface RawEvent {
  event_type?: string;
  asset_id?: string;
  timestamp?: string | number;
  bids?: RawLevel[];
  asks?: RawLevel[];
  price?: string;
  size?: string;
  side?: string;
  price_changes?: { asset_id: string; price?: string; size?: string; side?: string; best_bid?: string; best_ask?: string }[];
}

const n = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
const levels = (ls: RawLevel[] | undefined): Level[] => (ls ?? []).map((l) => [Number(l.price), Number(l.size)] as Level).filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s));

/** Libro de los tokens Up/Down de UN market (se crea uno por market): mejor bid/ask, niveles y trades. */
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
      const bids = levels(ev.bids);
      const asks = levels(ev.asks);
      this.emit("book", { token: ev.asset_id, bids, asks, time });
      const bid = bids.length ? Math.max(...bids.map((l) => l[0])) : null;
      const ask = asks.length ? Math.min(...asks.map((l) => l[0])) : null;
      this.emit("quote", { token: ev.asset_id, bid, ask, time });
    } else if (ev.event_type === "price_change" && ev.price_changes) {
      for (const c of ev.price_changes) {
        const price = n(c.price);
        const size = n(c.size);
        if (price !== null && size !== null && (c.side === "BUY" || c.side === "SELL")) {
          this.emit("level", { token: c.asset_id, side: c.side === "BUY" ? "bid" : "ask", price, size, time });
        }
        this.emit("quote", { token: c.asset_id, bid: n(c.best_bid), ask: n(c.best_ask), time });
      }
    } else if (ev.event_type === "last_trade_price" && ev.asset_id) {
      const price = n(ev.price);
      const size = n(ev.size);
      if (price !== null && size !== null && size > 0 && (ev.side === "BUY" || ev.side === "SELL")) {
        this.emit("trade", { token: ev.asset_id, price, size, side: ev.side === "BUY" ? "buy" : "sell", time: time ?? 0 });
      }
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
