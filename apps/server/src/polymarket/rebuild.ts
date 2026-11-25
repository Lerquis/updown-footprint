import type { CvdPoint, FootprintBar, OrderflowSignal } from "@updown/protocol";
import { OrderflowEngine, type EngineConfig } from "../analysis/engine.js";
import { TRADES_LEAD_MS, type MarketStore } from "./store.js";

export interface RebuiltOrderflow {
  bars: FootprintBar[];
  cvd: CvdPoint[];
  signals: OrderflowSignal[];
  trades: number;
}

/**
 * Rehace footprint, CVD y senales de un market a partir de los aggTrades guardados (con TRADES_LEAD_MS de historia previa).
 * Usa el mismo OrderflowEngine que el servidor en vivo, asi que con la misma configuracion da lo mismo.
 * Devuelve solo lo que cae dentro de [start, end).
 */
export function rebuildOrderflow(store: MarketStore, start: number, end: number, cfg: EngineConfig): RebuiltOrderflow {
  const trades = store.tradesBetween(start - TRADES_LEAD_MS, end + cfg.barMs); // un trade pasado el fin cierra la ultima barra
  const eng = new OrderflowEngine({ ...cfg, retentionMs: Math.max(cfg.retentionMs, TRADES_LEAD_MS + end - start) });
  for (const t of trades) eng.ingest(t);
  return {
    bars: eng.bars.filter((b) => b.start >= start && b.start < end),
    cvd: eng.cvdPoints.filter((p) => p.time > start && p.time <= end),
    signals: eng.signals.filter((s) => s.barStart >= start && s.barStart < end),
    trades: trades.length,
  };
}
