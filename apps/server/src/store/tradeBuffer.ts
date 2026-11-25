import type { AggTrade } from "@updown/protocol";

/**
 * Memoria de trades: conserva los de los ultimos `retentionMs` (reloj de Binance),
 * con un tope `max` de seguridad. Fuente del snapshot para clientes nuevos.
 */
export class TradeBuffer {
  private items: AggTrade[] = [];
  constructor(
    private readonly retentionMs: number,
    private readonly max: number,
  ) {}

  push(t: AggTrade): void {
    this.items.push(t);
    const cutoff = t.time - this.retentionMs;
    let drop = Math.max(0, this.items.length - this.max);
    while (drop < this.items.length && this.items[drop]!.time < cutoff) drop++;
    if (drop > 0) this.items.splice(0, drop);
  }

  snapshot(): AggTrade[] {
    return this.items.slice();
  }

  get size(): number {
    return this.items.length;
  }
}
