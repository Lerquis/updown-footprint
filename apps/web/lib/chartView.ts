import { exchangeClock } from "./exchangeClock";

export interface PriceRange {
  lo: number;
  hi: number;
}

const MIN_WIN_MS = 5_000;

/**
 * Estado de la vista (zoom/desplazamiento) COMPARTIDO por la grafica de precio y la de CVD.
 * Vive fuera de React: los canvas lo leen en cada frame y las interacciones lo modifican,
 * sin re-renderizar. `subscribe` solo sirve para mostrar/ocultar el boton "Restablecer".
 *
 * - Tiempo: `winMs` (ancho visible) y `endOffset` (<= 0: borde derecho respecto al "ahora" de Binance; 0 = en vivo).
 * - Precio: `priceCenter`/`priceSpan` manuales; null = autoescala.
 */
export class ChartView {
  winMs: number;
  presetMs: number;
  endOffset = 0;
  priceCenter: number | null = null;
  priceSpan: number | null = null;
  /** Rango de precio dibujado en el ultimo frame (lo rellena la grafica de precio) */
  lastRange: PriceRange = { lo: 0, hi: 1 };

  private subs = new Set<() => void>();
  private _custom = false;

  constructor(
    presetMs: number,
    /** memoria disponible: no se puede hacer zoom-out ni retroceder mas alla */
    public maxMs: number,
  ) {
    this.winMs = this.presetMs = presetMs;
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };

  /** true si la vista difiere de "ultimos `presetMs` en vivo con autoescala" */
  get custom(): boolean {
    return this._custom;
  }

  private update() {
    const c = this.endOffset !== 0 || this.priceCenter !== null || this.winMs !== this.presetMs;
    if (c !== this._custom) {
      this._custom = c;
      this.subs.forEach((f) => f());
    }
  }

  /** Borde derecho de la vista (ms, reloj de Binance) */
  end(): number {
    return exchangeClock.now() + this.endOffset;
  }

  setPreset(ms: number): void {
    this.presetMs = this.winMs = ms;
    this.endOffset = 0;
    this.priceCenter = this.priceSpan = null;
    this._custom = true; // fuerza notificacion
    this.update();
  }

  reset(): void {
    this.setPreset(this.presetMs);
  }

  /** factor > 1 aleja, < 1 acerca; `anchorFrac` (0..1) = posicion horizontal que queda fija */
  zoomTime(factor: number, anchorFrac: number): void {
    const from = this.end() - this.winMs;
    const anchor = from + anchorFrac * this.winMs;
    const win = Math.min(this.maxMs, Math.max(MIN_WIN_MS, this.winMs * factor));
    const newEnd = anchor + (1 - anchorFrac) * win;
    this.winMs = win;
    let off = Math.max(-this.maxMs, Math.min(0, newEnd - exchangeClock.now()));
    if (off > -0.03 * win) off = 0; // cerca del presente: se queda en vivo
    this.endOffset = off;
    this.update();
  }

  /** dMs > 0 avanza hacia el presente */
  panTime(dMs: number): void {
    this.endOffset = Math.max(-this.maxMs, Math.min(0, this.endOffset + dMs));
    this.update();
  }

  /** `anchorFrac` (0 = arriba, 1 = abajo) = posicion vertical que queda fija */
  zoomPrice(factor: number, anchorFrac: number): void {
    const { lo, hi } = this.lastRange;
    const span = hi - lo;
    const anchor = hi - anchorFrac * span;
    const newSpan = Math.max(span * 1e-3, span * factor);
    const newHi = anchor + anchorFrac * newSpan;
    this.priceSpan = newSpan;
    this.priceCenter = newHi - newSpan / 2;
    this.update();
  }

  panPrice(dPrice: number): void {
    const { lo, hi } = this.lastRange;
    this.priceSpan = this.priceSpan ?? hi - lo;
    this.priceCenter = (this.priceCenter ?? (lo + hi) / 2) + dPrice;
    this.update();
  }
}
