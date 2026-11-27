import type { CompareEngineMarket, CompareEngineTotals, CompareMarketRow, PmEngineId, PmEngineRun, PmEngineSummary, PmRecord, PmSide, PmSignal } from "@updown/protocol";

/**
 * Comparativa spot vs futures (ADR 0016, docs/features/futures-source.md): el mismo motor, en el mismo market de Polymarket,
 * alimentado por Binance spot o por el perpetuo. Lo importante es si futures ENTRA ANTES (y por tanto mas barato, antes de que
 * Polymarket se mueva). Funciones puras.
 */

export const COMPARE_ENGINES: PmEngineId[] = ["a", "c", "d", "e"];

/** Operaciones y resultado de un motor dentro de un record (A va en `points`/`trades`, el resto en `engines`) */
export function engineRun(rec: PmRecord, id: PmEngineId): Pick<PmEngineRun, "trades" | "pnl"> | null {
  if (id === "a") return { trades: rec.trades, pnl: rec.pnl };
  return rec.engines?.[id] ?? null;
}

/** Primera entrada (compra `entry`) del motor, o null si no entro */
export function firstEntry(trades: PmSignal[]): PmSignal | null {
  let best: PmSignal | null = null;
  for (const t of trades) if (t.action === "buy" && t.reason === "entry" && (!best || t.time < best.time)) best = t;
  return best;
}

const summary = (run: Pick<PmEngineRun, "trades" | "pnl"> | null): PmEngineSummary => ({
  trades: run?.trades.length ?? 0,
  invested: run?.pnl.invested ?? 0,
  net: run?.pnl.net ?? null,
});

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Un motor en un market: resultados y, si las dos fuentes entraron por el mismo lado, quien entro antes y a que precio */
export function compareEngine(spot: PmRecord, futures: PmRecord, id: PmEngineId): CompareEngineMarket {
  const s = engineRun(spot, id);
  const f = engineRun(futures, id);
  const se = firstEntry(s?.trades ?? []);
  const fe = firstEntry(f?.trades ?? []);
  const same = se !== null && fe !== null && se.side === fe.side;
  return {
    spot: summary(s),
    futures: summary(f),
    spotSide: (se?.side as PmSide | undefined) ?? null,
    futuresSide: (fe?.side as PmSide | undefined) ?? null,
    leadMs: same ? se!.time - fe!.time : null,
    priceDiff: same ? round(se!.price - fe!.price, 4) : null,
  };
}

/** Markets guardados por las dos fuentes (emparejados por slug), del mas reciente al mas antiguo */
export function compareMarkets(spot: PmRecord[], futures: PmRecord[]): CompareMarketRow[] {
  const bySlug = new Map(futures.map((r) => [r.market.slug, r]));
  const rows: CompareMarketRow[] = [];
  for (const s of spot) {
    const f = bySlug.get(s.market.slug);
    if (!f || s.market.result === null) continue;
    rows.push({
      slug: s.market.slug,
      start: s.market.start,
      result: s.market.result,
      engines: Object.fromEntries(COMPARE_ENGINES.map((id) => [id, compareEngine(s, f, id)])) as Record<PmEngineId, CompareEngineMarket>,
    });
  }
  return rows.sort((a, b) => b.start - a.start);
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Totales de cada motor sobre las filas comparadas */
export function compareTotals(rows: CompareMarketRow[]): Record<PmEngineId, CompareEngineTotals> {
  const out = {} as Record<PmEngineId, CompareEngineTotals>;
  for (const id of COMPARE_ENGINES) {
    const leads: number[] = [];
    const diffs: number[] = [];
    const t: CompareEngineTotals = {
      markets: rows.length,
      spotNet: 0,
      futuresNet: 0,
      spotInvested: 0,
      futuresInvested: 0,
      spotTrades: 0,
      futuresTrades: 0,
      sameSide: 0,
      futuresFirst: 0,
      spotFirst: 0,
      avgLeadMs: null,
      medianLeadMs: null,
      avgPriceDiff: null,
      onlySpot: 0,
      onlyFutures: 0,
      oppositeSide: 0,
    };
    for (const r of rows) {
      const e = r.engines[id];
      t.spotNet += e.spot.net ?? 0;
      t.futuresNet += e.futures.net ?? 0;
      t.spotInvested += e.spot.invested;
      t.futuresInvested += e.futures.invested;
      t.spotTrades += e.spot.trades;
      t.futuresTrades += e.futures.trades;
      if (e.leadMs !== null) {
        t.sameSide++;
        leads.push(e.leadMs);
        if (e.priceDiff !== null) diffs.push(e.priceDiff);
        if (e.leadMs > 0) t.futuresFirst++;
        else if (e.leadMs < 0) t.spotFirst++;
      } else if (e.spotSide && e.futuresSide) t.oppositeSide++;
      else if (e.spotSide) t.onlySpot++;
      else if (e.futuresSide) t.onlyFutures++;
    }
    const avgLead = mean(leads);
    const medLead = median(leads);
    const avgDiff = mean(diffs);
    out[id] = {
      ...t,
      spotNet: round(t.spotNet, 2),
      futuresNet: round(t.futuresNet, 2),
      spotInvested: round(t.spotInvested, 2),
      futuresInvested: round(t.futuresInvested, 2),
      avgLeadMs: avgLead === null ? null : Math.round(avgLead),
      medianLeadMs: medLead === null ? null : Math.round(medLead),
      avgPriceDiff: avgDiff === null ? null : round(avgDiff, 4),
    };
  }
  return out;
}
