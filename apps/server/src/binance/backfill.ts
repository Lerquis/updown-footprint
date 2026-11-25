import type { AggTrade } from "@updown/protocol";

interface RawRestAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

/**
 * Descarga los aggTrades desde `fromTime` hasta ahora con el REST de Binance (1000 por pagina,
 * paginando por `fromId`) y los entrega EN ORDEN a `onTrade`. Devuelve cuantos entrego.
 * Si falla a medias, devuelve lo entregado hasta ahi (el stream en vivo continua igualmente).
 */
export async function backfillTrades(
  restUrl: string,
  symbol: string,
  fromTime: number,
  onTrade: (t: AggTrade) => void,
): Promise<number> {
  const sym = symbol.toUpperCase();
  let count = 0;
  let fromId: number | undefined;
  try {
    for (let page = 0; page < 500; page++) {
      const qs = fromId === undefined ? `startTime=${fromTime}` : `fromId=${fromId}`;
      const res = await fetch(`${restUrl}/aggTrades?symbol=${sym}&${qs}&limit=1000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const batch = (await res.json()) as RawRestAggTrade[];
      for (const r of batch) {
        onTrade({ id: r.a, symbol: sym, price: Number(r.p), quantity: Number(r.q), time: r.T, isBuyerMaker: r.m });
        count++;
      }
      if (batch.length < 1000) break;
      fromId = batch[batch.length - 1]!.a + 1;
      await new Promise((r) => setTimeout(r, 60)); // cortesia con el rate limit
    }
  } catch (err) {
    console.error("[backfill] interrupted:", (err as Error).message);
  }
  return count;
}
