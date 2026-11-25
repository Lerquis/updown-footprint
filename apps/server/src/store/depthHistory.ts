import type { DepthColumn } from "@updown/protocol";

/** Ring buffer de columnas del heatmap (1 por intervalo de muestreo). */
export class DepthHistory {
  private items: DepthColumn[] = [];
  constructor(private readonly max: number) {}

  push(c: DepthColumn): void {
    this.items.push(c);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  snapshot(): DepthColumn[] {
    return this.items.slice();
  }

  get size(): number {
    return this.items.length;
  }
}
