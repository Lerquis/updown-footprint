import type { PmMarket } from "@updown/protocol";
import type { MarketResult, PolymarketApi } from "../polymarket/api.js";
import { parseRound, resultOf, tokenOf, type PredictRound, type PredictTradingInfo, type RawRound } from "./model.js";

/**
 * REST de Predict.fun (mainnet exige `x-api-key` incluso para leer). Solo lectura: rondas de una serie up/down.
 * `ACTIVE` = las que no han terminado (la primera es la en curso; las siguientes ya existen). `ENDED` = terminadas, recientes primero.
 */
export async function fetchRounds(baseUrl: string, apiKey: string, series: string, status: "ACTIVE" | "ENDED", first: number): Promise<RawRound[]> {
  const url = `${baseUrl}/v1/series/${encodeURIComponent(series)}/rounds?status=${status}&first=${first}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${status}`);
  const body = (await res.json()) as { success?: boolean; data?: RawRound[] };
  if (!body.success || !Array.isArray(body.data)) throw new Error(`respuesta inesperada en ${status}`);
  return body.data;
}

export interface PredictApiConfig {
  restUrl: string;
  apiKey: string;
  series: string;
}

/** una consulta por estado como mucho cada CACHE_MS, la compartan las fuentes que la compartan */
const CACHE_MS = 2000;

/**
 * La API de markets que usa `PolymarketTracker`, servida con las rondas de Predict. Los slugs tienen el mismo formato que
 * en Polymarket (`btc-updown-5m-<inicio en s>`), asi que el tracker rota igual. Tokens sinteticos `<marketId>:up|down`
 * (ver `PredictBook`). Las dos fuentes (spot y futures) comparten una instancia: una sola consulta cada 2 s como mucho.
 */
export class PredictMarketApi implements PolymarketApi {
  private cache: Record<"ACTIVE" | "ENDED", { at: number; rounds: PredictRound[]; pending: Promise<PredictRound[]> | null }> = {
    ACTIVE: { at: 0, rounds: [], pending: null },
    ENDED: { at: 0, rounds: [], pending: null },
  };
  /** ultimo estado del REST: ok, error o sin API key (para /health) */
  rest: "ok" | "error" | "nokey" | "pending";

  constructor(private readonly cfg: PredictApiConfig) {
    this.rest = cfg.apiKey ? "pending" : "nokey";
    if (!cfg.apiKey) console.log("[predict] sin PREDICT_API_KEY: no se pueden pedir las rondas (los motores de Predict no tendran markets)");
  }

  private async rounds(status: "ACTIVE" | "ENDED"): Promise<PredictRound[]> {
    if (!this.cfg.apiKey) return [];
    const c = this.cache[status];
    if (Date.now() - c.at < CACHE_MS) return c.rounds;
    c.pending ??= fetchRounds(this.cfg.restUrl, this.cfg.apiKey, this.cfg.series, status, status === "ACTIVE" ? 3 : 10)
      .then((raw) => {
        c.rounds = raw.map(parseRound).filter((r): r is PredictRound => r !== null);
        c.at = Date.now();
        this.rest = "ok";
        return c.rounds;
      })
      .catch((e: unknown) => {
        if (this.rest !== "error") console.warn(`[predict] fallo al pedir las rondas: ${e instanceof Error ? e.message : e}`);
        this.rest = "error";
        c.at = Date.now(); // no reintentar en bucle: el tracker vuelve a preguntar en su siguiente reintento
        return c.rounds;
      })
      .finally(() => (c.pending = null));
    return c.pending;
  }

  private async find(slug: string): Promise<PredictRound | null> {
    const active = await this.rounds("ACTIVE");
    return active.find((r) => r.slug === slug) ?? (await this.rounds("ENDED")).find((r) => r.slug === slug) ?? null;
  }

  /** Datos para firmar ordenes del market (de la ultima consulta de rondas activas) */
  tradingInfo(marketId: number): PredictTradingInfo | null {
    return this.cache.ACTIVE.rounds.find((r) => r.marketId === marketId)?.trading ?? null;
  }

  async fetchMarket(slug: string): Promise<Pick<PmMarket, "title" | "upToken" | "downToken"> | null> {
    const r = (await this.rounds("ACTIVE")).find((x) => x.slug === slug);
    return r ? { title: r.title, upToken: tokenOf(r.marketId, "up"), downToken: tokenOf(r.marketId, "down") } : null;
  }

  async fetchPriceToBeat(start: number): Promise<number | null> {
    const active = await this.rounds("ACTIVE");
    const r = active.find((x) => x.start === start) ?? (await this.rounds("ENDED")).find((x) => x.start === start);
    return r?.priceToBeat ?? null;
  }

  /** Resultado con el cierre de Predict; un empate (50-50) no tiene lado y se queda sin resultado */
  async fetchResult(slug: string): Promise<MarketResult | null> {
    const r = (await this.rounds("ENDED")).find((x) => x.slug === slug) ?? (await this.find(slug));
    if (!r) return null;
    const result = resultOf(r.priceToBeat, r.closePrice);
    if (!result || r.priceToBeat === null || r.closePrice === null) return null;
    return { result, openPrice: r.priceToBeat, closePrice: r.closePrice, changePct: ((r.closePrice - r.priceToBeat) / r.priceToBeat) * 100 };
  }
}
