import { EventEmitter } from "node:events";
import type { UpstreamState } from "@updown/protocol";
import type { Level, PmTrade } from "../polymarket/pmBook.js";
import type { BookLevel, BookLike, BookQuote, BookSnapshot } from "../polymarket/tracker.js";
import { diffLevels, mirrorBook, parseToken } from "./model.js";
import { PredictWs } from "./wsClient.js";

interface PredictBookEvents {
  quote: [BookQuote];
  state: [UpstreamState];
  book: [BookSnapshot];
  level: [BookLevel];
  trade: [PmTrade];
}

/**
 * Libro de UN market de Predict con la interfaz del `BookClient` de Polymarket (tokens `<marketId>:up|down`), para que
 * `PolymarketTracker` y los motores lo usen igual. Predict manda el libro entero de Up en cada mensaje
 * (`predictOrderbook/{marketId}`): el primero (y el primero tras cada reconexion) se emite como `book`; los siguientes como
 * cambios de nivel (`level`). Down es el espejo de Up (1 - precio). Predict no publica el tamano de cada trade, asi que no hay
 * eventos `trade`.
 */
export class PredictBook extends EventEmitter<PredictBookEvents> implements BookLike {
  private readonly ws: PredictWs;
  private readonly marketId: number;
  private readonly up: string;
  private readonly down: string;
  /** ultimo libro de cada token; null = el proximo mensaje es un libro completo */
  private last: Record<string, { bids: Level[]; asks: Level[] }> | null = null;

  constructor(url: string, tokens: string[]) {
    super();
    const up = tokens.map(parseToken).find((t) => t?.side === "up");
    if (!up) throw new Error(`token de Predict invalido: ${tokens.join(", ")}`);
    this.marketId = up.marketId;
    this.up = tokens[0]!;
    this.down = tokens[1]!;
    this.ws = new PredictWs("predict-book", url, null);
    this.ws.subscribe(`predictOrderbook/${this.marketId}`);
    this.ws.on("state", (s) => {
      if (s !== "connected") this.last = null;
      this.emit("state", s);
    });
    this.ws.on("orderbook", (b) => {
      if (b.marketId === this.marketId) this.onBook(b.bids, b.asks, b.time);
    });
  }

  private onBook(upBids: Level[], upAsks: Level[], time: number | null) {
    const books = { [this.up]: { bids: upBids, asks: upAsks }, [this.down]: mirrorBook(upBids, upAsks) };
    for (const token of [this.up, this.down]) {
      const b = books[token]!;
      const prev = this.last?.[token];
      if (!prev) this.emit("book", { token, bids: b.bids, asks: b.asks, time });
      else {
        for (const [price, size] of diffLevels(prev.bids, b.bids)) this.emit("level", { token, side: "bid", price, size, time });
        for (const [price, size] of diffLevels(prev.asks, b.asks)) this.emit("level", { token, side: "ask", price, size, time });
      }
      this.emit("quote", { token, bid: b.bids[0]?.[0] ?? null, ask: b.asks[0]?.[0] ?? null, time });
    }
    this.last = books;
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
