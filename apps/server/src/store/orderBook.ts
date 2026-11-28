import type { DepthColumn } from "@updown/protocol";

export interface DepthLevels {
  bids: [string, string][];
  asks: [string, string][];
}

/** Libro de ordenes local (precio -> cantidad). Se alimenta con snapshot REST + diffs del stream. */
export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  lastUpdateId = 0;

  reset(lastUpdateId: number, levels: DepthLevels): void {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = lastUpdateId;
    this.apply(levels);
  }

  apply(levels: DepthLevels): void {
    for (const [p, q] of levels.bids) this.set(this.bids, Number(p), Number(q));
    for (const [p, q] of levels.asks) this.set(this.asks, Number(p), Number(q));
  }

  private set(side: Map<number, number>, price: number, qty: number) {
    if (qty === 0) side.delete(price);
    else side.set(price, qty);
  }

  get ready(): boolean {
    return this.bids.size > 0 && this.asks.size > 0;
  }

  bestBid(): number {
    let b = 0;
    for (const p of this.bids.keys()) if (p > b) b = p;
    return b;
  }

  bestAsk(): number {
    let a = Infinity;
    for (const p of this.asks.keys()) if (p < a) a = p;
    return a;
  }

  /** Niveles crudos (precio, cantidad) para calculos de solo lectura. */
  sides(): { bids: Map<number, number>; asks: Map<number, number> } {
    return { bids: this.bids, asks: this.asks };
  }

  /**
   * Agrega el libro en buckets de `step` dentro de mid ± rangePct.
   * Devuelve null si el libro aun no es utilizable.
   */
  toColumn(step: number, rangePct: number, time: number): DepthColumn | null {
    if (!this.ready) return null;
    const mid = (this.bestBid() + this.bestAsk()) / 2;
    const half = mid * rangePct;
    const lo = Math.floor((mid - half) / step) * step;
    const n = Math.ceil((2 * half) / step) + 1;
    const q = new Array<number>(n).fill(0);
    const add = (side: Map<number, number>) => {
      for (const [p, qty] of side) {
        const i = Math.floor((p - lo) / step);
        if (i >= 0 && i < n) q[i]! += qty;
      }
    };
    add(this.bids);
    add(this.asks);
    // 3 decimales bastan para el heatmap y recortan mucho el JSON
    for (let i = 0; i < n; i++) q[i] = Math.round(q[i]! * 1000) / 1000;
    return { time, mid, lo: Math.round(lo * 100) / 100, q };
  }
}
