import type { PmPoint, PmRecord, PmReplayFill, PmReplayMarket, PmReplayRun, PmSide, PmSignal } from "@updown/protocol";
import { takerFee } from "./model.js";
import { computePnl, DEFAULT_STRATEGY, replayMarket, type StrategyConfig } from "./strategy.js";

/**
 * Replays del motor A con ejecucion retrasada (docs/features/replays.md).
 * El motor decide igual que siempre en el segundo T; cada orden se ejecuta con el libro de T + retraso:
 * compra al ask de ese instante (mismo importe en USDC, otro numero de tokens) y vende al bid de ese instante
 * los tokens que de verdad se compraron. Funciones puras.
 */

/** Holgura al buscar la muestra de T + retraso: en la base v1 las muestras no caen en el segundo exacto (x,896 s, x,901 s...). */
export const EXEC_TOLERANCE_MS = 200;

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Primera muestra con time >= target - tolerancia (points en orden de tiempo). */
function pointAt(points: PmPoint[], target: number): PmPoint | null {
  let lo = 0;
  let hi = points.length;
  const t = target - EXEC_TOLERANCE_MS;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return points[lo] ?? null;
}

/**
 * Ejecuta las senales `trades` `delayS` segundos despues, con los precios de `points` (las muestras del propio motor).
 * Con delayS 0 cada orden se ejecuta al precio de su senal (equivale al resultado de papel).
 * Comision y deslizamiento iguales que en el paper (`cfg.feeRate`, `cfg.slippage`): la unica diferencia es el instante.
 */
export function executeWithDelay(
  trades: PmSignal[],
  points: PmPoint[],
  delayS: number,
  result: "up" | "down" | null,
  cfg: Pick<StrategyConfig, "feeRate" | "slippage"> = DEFAULT_STRATEGY,
): PmReplayRun {
  const pos: Record<PmSide, number> = { up: 0, down: 0 };
  const fills: PmReplayFill[] = [];
  for (const t of trades) {
    const at = delayS === 0 ? null : pointAt(points, t.time + delayS * 1000);
    const execTime = delayS === 0 ? t.time : (at?.time ?? null);
    const base = { time: t.time, execTime, action: t.action, side: t.side, reason: t.reason, signalPrice: t.price };
    const miss = (status: PmReplayFill["status"]): PmReplayFill => ({ ...base, execPrice: null, shares: 0, amount: 0, status });

    if (t.action === "buy") {
      const ask = delayS === 0 ? t.price : t.side === "up" ? (at?.upAsk ?? null) : (at?.downAsk ?? null);
      if (ask === null || ask <= 0 || ask >= 1) {
        fills.push(miss("missed"));
        continue;
      }
      const cost = ask + takerFee(ask, cfg.feeRate) + cfg.slippage;
      const shares = t.amount / cost;
      pos[t.side] += shares;
      fills.push({ ...base, execPrice: ask, shares: round(shares, 3), amount: t.amount, status: "filled" });
    } else {
      if (pos[t.side] <= 0) {
        fills.push(miss("noPosition"));
        continue;
      }
      const bid = delayS === 0 ? t.price : t.side === "up" ? (at?.upBid ?? null) : (at?.downBid ?? null);
      if (bid === null || bid <= 0) {
        fills.push(miss("missed")); // sin comprador: se mantiene hasta el cierre
        continue;
      }
      const shares = pos[t.side];
      const amount = shares * (bid - takerFee(bid, cfg.feeRate) - cfg.slippage);
      pos[t.side] = 0;
      fills.push({ ...base, execPrice: bid, shares: round(shares, 3), amount: round(amount, 2), status: "filled" });
    }
  }
  const done = fills.filter((f) => f.status === "filled");
  return { delayS, fills, pnl: computePnl(done, result) };
}

/**
 * Reproduce el motor A (reglas actuales, `cfg`) sobre las muestras guardadas de un market y lo ejecuta con cada retraso.
 * Las muestras de A estan en `rec.points` en las dos generaciones de la base.
 */
export function replayRecordDelayed(rec: PmRecord, generation: "v1" | "v2", delays: number[], cfg: StrategyConfig = DEFAULT_STRATEGY): PmReplayMarket {
  const m = rec.market;
  const points = [...rec.points].sort((a, b) => a.time - b.time);
  const { trades } = replayMarket(m, points, cfg);
  return {
    slug: m.slug,
    start: m.start,
    end: m.end,
    result: m.result ?? "up",
    generation,
    runs: delays.map((d) => executeWithDelay(trades, points, d, m.result, cfg)),
  };
}
