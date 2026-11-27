/**
 * Libro completo (L2) de los tokens de Polymarket, alimentado por el canal de market (`book` + `price_change`), y los
 * trades del token (`last_trade_price`). Lo usan los motores D y E: D para estimar a que precio se ejecutaria de verdad un
 * importe (recorriendo niveles), E para simular su lugar en la cola de una orden en reposo. Ver docs/features/predictive-engines.md.
 */

/** Nivel del libro: precio (0-1) y tokens */
export type Level = [price: number, size: number];

/** Trade de Polymarket: `side` es el del taker (buy = alguien compro contra los asks) */
export interface PmTrade {
  token: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  /** reloj de Polymarket (ms) */
  time: number;
}

const key = (p: number) => Math.round(p * 1000) / 1000;

export class TokenBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  /** marca de tiempo del ultimo cambio (ms) */
  time = 0;

  snapshot(bids: Level[], asks: Level[], time: number): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of bids) if (s > 0) this.bids.set(key(p), s);
    for (const [p, s] of asks) if (s > 0) this.asks.set(key(p), s);
    this.time = time;
  }

  /** Nuevo tamano total de un nivel (0 = desaparece). `side` bid/ask. */
  set(side: "bid" | "ask", price: number, size: number, time: number): void {
    const m = side === "bid" ? this.bids : this.asks;
    if (size > 0) m.set(key(price), size);
    else m.delete(key(price));
    this.time = Math.max(this.time, time);
  }

  bestBid(): number | null {
    let b: number | null = null;
    for (const p of this.bids.keys()) if (b === null || p > b) b = p;
    return b;
  }

  bestAsk(): number | null {
    let a: number | null = null;
    for (const p of this.asks.keys()) if (a === null || p < a) a = p;
    return a;
  }

  /** Tokens en reposo en ese precio y lado */
  sizeAt(side: "bid" | "ask", price: number): number {
    return (side === "bid" ? this.bids : this.asks).get(key(price)) ?? 0;
  }

  /** Niveles ordenados del mejor al peor */
  levels(side: "bid" | "ask"): Level[] {
    const out = [...(side === "bid" ? this.bids : this.asks).entries()];
    return out.sort((x, y) => (side === "bid" ? y[0] - x[0] : x[0] - y[0]));
  }
}

/**
 * Ejecucion de una orden taker contra los niveles (del mejor al peor) sin pasar de `limit`.
 * Compra: `usd` a gastar (sin comision). Venta: `shares` a vender. Devuelve tokens y USDC ejecutados y el precio medio. Funcion pura.
 */
export function walkBook(levels: Level[], action: "buy" | "sell", amount: number, limit: number): { shares: number; usd: number; avg: number | null } {
  let shares = 0;
  let usd = 0;
  let left = amount;
  for (const [p, s] of levels) {
    if (left <= 1e-9) break;
    if (action === "buy" ? p > limit + 1e-9 : p < limit - 1e-9) break;
    if (action === "buy") {
      const take = Math.min(s, left / p);
      shares += take;
      usd += take * p;
      left -= take * p;
    } else {
      const take = Math.min(s, left);
      shares += take;
      usd += take * p;
      left -= take;
    }
  }
  return { shares, usd, avg: shares > 0 ? usd / shares : null };
}

/** Libros de todos los tokens seguidos (se crean al primer mensaje de cada token). */
export class PmBooks {
  private readonly books = new Map<string, TokenBook>();

  get(token: string): TokenBook {
    let b = this.books.get(token);
    if (!b) this.books.set(token, (b = new TokenBook()));
    return b;
  }

  has(token: string): boolean {
    return this.books.has(token);
  }

  /** Olvida los tokens que ya no se usan */
  prune(keep: Set<string>): void {
    for (const t of this.books.keys()) if (!keep.has(t)) this.books.delete(t);
  }
}
