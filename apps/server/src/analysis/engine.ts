import { EventEmitter } from "node:events";
import type { AggTrade, CvdPoint, FootprintBar, FootprintLevel, OrderflowSignal } from "@updown/protocol";
import { computeImbalances, detectAll, type DetectorConfig } from "./detectors.js";

export interface EngineConfig {
  barMs: number;
  barHistory: number;
  tick: number;
  retentionMs: number;
  detector: DetectorConfig;
}

export interface EngineEvents {
  /** barra en formacion (cada `tick()`) o recien cerrada */
  bar: [FootprintBar];
  cvd: [CvdPoint];
  signal: [OrderflowSignal];
}

/** Barra en construccion: acumula volumen bid/ask por nivel de precio. */
class BarBuilder {
  open = 0;
  high = -Infinity;
  low = Infinity;
  close = 0;
  volume = 0;
  delta = 0;
  private levels = new Map<number, [number, number]>(); // idx -> [bid, ask]

  constructor(
    readonly start: number,
    private readonly tick: number,
  ) {}

  add(t: AggTrade): void {
    if (!this.volume) this.open = t.price;
    this.high = Math.max(this.high, t.price);
    this.low = Math.min(this.low, t.price);
    this.close = t.price;
    this.volume += t.quantity;
    const idx = Math.floor(t.price / this.tick + 1e-9);
    const l = this.levels.get(idx) ?? [0, 0];
    // isBuyerMaker => el vendedor agredio => golpeo el bid
    if (t.isBuyerMaker) {
      l[0] += t.quantity;
      this.delta -= t.quantity;
    } else {
      l[1] += t.quantity;
      this.delta += t.quantity;
    }
    this.levels.set(idx, l);
  }

  get empty(): boolean {
    return this.volume === 0;
  }

  toBar(closed: boolean, cvd: number, det: DetectorConfig): FootprintBar {
    const levels: FootprintLevel[] = [...this.levels.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, [bid, ask]]) => [Number((idx * this.tick).toFixed(8)), round(bid), round(ask)]);
    return {
      start: this.start,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      volume: round(this.volume),
      delta: round(this.delta),
      cvdClose: round(cvd),
      closed,
      levels,
      imbalances: computeImbalances(levels, det),
    };
  }
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Motor de orderflow: a partir de los aggTrades (en orden) mantiene
 *  - barras footprint de `barMs`,
 *  - CVD acumulado y muestreado cada segundo,
 *  - senales detectadas al cerrar cada barra.
 * El tiempo lo marcan los propios trades (reloj de Binance); `tick()` lo hace avanzar en mercados quietos.
 */
export class OrderflowEngine extends EventEmitter<EngineEvents> {
  readonly bars: FootprintBar[] = [];
  readonly cvdPoints: CvdPoint[] = [];
  readonly signals: OrderflowSignal[] = [];

  private forming?: BarBuilder;
  private cvd = 0;
  private lastPrice = 0;
  private lastTradeTime = 0;
  private lastTradeWall = 0;
  private curSec = 0;
  private secVol = 0;

  constructor(private readonly cfg: EngineConfig) {
    super();
  }

  /** Hora actual estimada en el reloj de Binance. */
  exchangeNow(): number {
    return this.lastTradeTime ? this.lastTradeTime + (Date.now() - this.lastTradeWall) : Date.now();
  }

  get formingBar(): FootprintBar | undefined {
    return this.forming && !this.forming.empty ? this.forming.toBar(false, this.cvd, this.cfg.detector) : undefined;
  }

  get currentCvd(): number {
    return this.cvd;
  }

  get price(): number {
    return this.lastPrice;
  }

  ingest(t: AggTrade): void {
    this.advanceTo(t.time);
    const start = Math.floor(t.time / this.cfg.barMs) * this.cfg.barMs;
    if (!this.forming) this.forming = new BarBuilder(start, this.cfg.tick);
    this.forming.add(t);
    this.cvd += t.isBuyerMaker ? -t.quantity : t.quantity;
    this.secVol += t.quantity;
    this.lastPrice = t.price;
    this.lastTradeTime = t.time;
    this.lastTradeWall = Date.now();
  }

  /** Avanza el reloj al ahora estimado: cierra segundos/barras y emite la barra en formacion. */
  tick(): void {
    if (!this.lastTradeTime) return;
    this.advanceTo(this.exchangeNow());
    const fb = this.formingBar;
    if (fb) this.emit("bar", fb);
  }

  private advanceTo(time: number): void {
    const startOfBar = Math.floor(time / this.cfg.barMs) * this.cfg.barMs;
    if (this.forming && startOfBar > this.forming.start) this.closeForming();

    const sec = Math.floor(time / 1000);
    if (!this.curSec) this.curSec = sec;
    if (sec - this.curSec > 3600) this.curSec = sec; // hueco enorme: no rellenar
    while (this.curSec < sec) {
      const p: CvdPoint = { time: (this.curSec + 1) * 1000, cvd: round(this.cvd), price: this.lastPrice, vol: round(this.secVol) };
      this.secVol = 0;
      this.curSec++;
      this.cvdPoints.push(p);
      this.emit("cvd", p);
    }
    const cutoff = time - this.cfg.retentionMs;
    let drop = 0;
    while (drop < this.cvdPoints.length && this.cvdPoints[drop]!.time < cutoff) drop++;
    if (drop) this.cvdPoints.splice(0, drop);
  }

  private closeForming(): void {
    const fb = this.forming!;
    this.forming = undefined;
    if (fb.empty) return;
    const bar = fb.toBar(true, this.cvd, this.cfg.detector);
    const prev = this.bars.slice();
    this.bars.push(bar);
    if (this.bars.length > this.cfg.barHistory) this.bars.splice(0, this.bars.length - this.cfg.barHistory);
    this.emit("bar", bar);

    for (const s of detectAll(bar, prev, this.cfg.detector)) {
      this.signals.push(s);
      this.emit("signal", s);
    }
    const sigCutoff = bar.start - this.cfg.barHistory * this.cfg.barMs;
    let drop = 0;
    while (drop < this.signals.length && this.signals[drop]!.barStart < sigCutoff) drop++;
    if (drop) this.signals.splice(0, drop);
  }

  /** Barras cerradas + la que se forma (para el snapshot). */
  allBars(): FootprintBar[] {
    const fb = this.formingBar;
    return fb ? [...this.bars, fb] : this.bars.slice();
  }
}
