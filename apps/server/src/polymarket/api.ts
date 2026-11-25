import type { PmMarket } from "@updown/protocol";

export interface MarketResult {
  result: "up" | "down";
  openPrice: number | null;
  closePrice: number | null;
  changePct: number | null;
}

/** Acceso HTTP a Polymarket (inyectable en `PolymarketTracker` para pruebas). */
export interface PolymarketApi {
  /** Datos del market por slug; null si aun no existe */
  fetchMarket(slug: string): Promise<Pick<PmMarket, "title" | "upToken" | "downToken"> | null>;
  /** Price to beat (openPrice) del market; null si Polymarket aun no lo publica */
  fetchPriceToBeat(start: number, end: number): Promise<number | null>;
  /** Resultado oficial del market ya terminado; null mientras Polymarket no lo publica */
  fetchResult(slug: string, start: number, end: number): Promise<MarketResult | null>;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export class HttpPolymarketApi implements PolymarketApi {
  constructor(
    private readonly gammaUrl: string,
    private readonly siteUrl: string,
    private readonly symbol: string, // BTC
    private readonly variant: string, // fiveminute
    private readonly marketMs: number,
    private readonly twapSeconds: number,
  ) {}

  async fetchMarket(slug: string) {
    const ev = (await getJson(`${this.gammaUrl}/events/slug/${slug}`)) as {
      title?: string;
      markets?: { outcomes?: string; clobTokenIds?: string }[];
    } | null;
    const m = ev?.markets?.[0];
    if (!m?.outcomes || !m.clobTokenIds) return null;
    try {
      const outcomes = JSON.parse(m.outcomes) as string[];
      const ids = JSON.parse(m.clobTokenIds) as string[];
      const up = ids[outcomes.findIndex((o) => o.toLowerCase() === "up")];
      const down = ids[outcomes.findIndex((o) => o.toLowerCase() === "down")];
      if (!up || !down) return null;
      return { title: ev?.title ?? slug, upToken: up, downToken: down };
    } catch {
      return null;
    }
  }

  /**
   * `crypto-price` con TWAP (`twapEnabled`/`twapLookbackSeconds`): es el calculo con que Polymarket
   * resuelve. `openPrice` es el price to beat (existe desde que empieza el market) y `closePrice` llega
   * al terminar (`completed`). Sin TWAP devuelve el spot, que puede contradecir el resultado oficial.
   */
  private async cryptoPrice(start: number, end: number) {
    const q = new URLSearchParams({
      symbol: this.symbol,
      eventStartTime: iso(start),
      variant: this.variant,
      endDate: iso(end),
      twapEnabled: "true",
      twapLookbackSeconds: String(this.twapSeconds),
    });
    const r = (await getJson(`${this.siteUrl}/api/crypto/crypto-price?${q}`)) as {
      openPrice?: number | null;
      closePrice?: number | null;
      completed?: boolean;
    } | null;
    return { open: r?.openPrice ?? null, close: r?.completed ? (r.closePrice ?? null) : null };
  }

  async fetchPriceToBeat(start: number, end: number) {
    return (await this.cryptoPrice(start, end)).open;
  }

  /**
   * `past-results` con `includeOutcomesBySlug`: el "market actual" de la consulta es el siguiente al
   * que preguntamos (empieza en `end`) y `pastEventSlugs` lleva el que queremos resolver. El resultado
   * oficial sale de `outcomesBySlug`; apertura/cierre salen de `crypto-price` con TWAP (los de
   * `results` son spot y pueden contradecirlo).
   */
  async fetchResult(slug: string, start: number, end: number): Promise<MarketResult | null> {
    const q = new URLSearchParams({
      symbol: this.symbol,
      variant: this.variant,
      assetType: "crypto",
      currentEventStartTime: iso(end),
      count: "1",
      endDate: iso(end + this.marketMs),
      includeOutcomesBySlug: "true",
    });
    q.append("pastEventSlugs", slug);
    const r = (await getJson(`${this.siteUrl}/api/past-results?${q}`)) as {
      data?: { outcomesBySlug?: Record<string, string> };
    } | null;
    const o = r?.data?.outcomesBySlug?.[slug]?.toLowerCase();
    if (o !== "up" && o !== "down") return null;

    // Sin el cierre TWAP todavia no damos el market por resuelto: se reintenta.
    const { open, close } = await this.cryptoPrice(start, end);
    if (open === null || close === null) return null;
    return { result: o, openPrice: open, closePrice: close, changePct: ((close - open) / open) * 100 };
  }
}
