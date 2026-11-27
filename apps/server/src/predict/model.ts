import type { Level } from "../polymarket/pmBook.js";

/**
 * Funciones puras de Predict.fun (rondas Up/Down 5m): normalizar las rondas del REST, resultado, tokens sinteticos y el
 * libro de Down derivado del de Up. Prueba en `predict.test.ts`. Ver docs/features/predict-markets.md.
 */

interface RawUpDown {
  startPrice?: number | null;
  endPrice?: number | null;
}
interface RawMarket {
  id?: number;
  title?: string;
  outcomes?: { name?: string; indexSet?: number; onChainId?: string }[];
  feeRateBps?: number;
  decimalPrecision?: number;
  isNegRisk?: boolean;
  isYieldBearing?: boolean;
  variantData?: RawUpDown | null;
}
/** Ronda tal como la devuelve `GET /v1/series/{slug}/rounds` (una categoria con sus markets). Solo lo que se usa. */
export interface RawRound {
  slug?: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  markets?: RawMarket[];
  variantDetails?: { upDown?: RawUpDown | null; crypto?: RawUpDown | null } | null;
  variantData?: RawUpDown | null;
}

/** Ronda normalizada */
export interface PredictRound {
  slug: string;
  marketId: number;
  title: string;
  start: number;
  end: number;
  /** `startPrice`: Chainlink al abrir la ventana; null hasta entonces */
  priceToBeat: number | null;
  /** `endPrice`: null hasta resolver */
  closePrice: number | null;
  /** lo que hace falta para firmar una orden (compras reales) */
  trading: PredictTradingInfo | null;
}

/** Datos de un market para firmar ordenes: token on-chain de cada lado, comision y exchange */
export interface PredictTradingInfo {
  upTokenId: string;
  downTokenId: string;
  feeRateBps: number;
  decimalPrecision: number;
  isNegRisk: boolean;
  isYieldBearing: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Precios redondeados a 6 decimales: 1 - 0.83 en coma flotante da 0.17000000000000004 */
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Resultado: up si cierre > apertura, down si <; null sin datos o si empatan (Predict resuelve 50-50) */
export function resultOf(priceToBeat: number | null, closePrice: number | null): "up" | "down" | null {
  if (priceToBeat === null || closePrice === null || closePrice === priceToBeat) return null;
  return closePrice > priceToBeat ? "up" : "down";
}

/**
 * Normaliza una ronda. Exige un market cuyo outcome `indexSet` 1 sea "Up" (el libro de Predict esta en ese outcome):
 * si algun dia cambia, la ronda se descarta en vez de operar con los precios al reves.
 */
export function parseRound(raw: RawRound): PredictRound | null {
  const m = raw.markets?.[0];
  const start = Date.parse(raw.startsAt ?? "");
  const end = Date.parse(raw.endsAt ?? "");
  if (!raw.slug || !m || typeof m.id !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const up = m.outcomes?.find((o) => o.indexSet === 1);
  if (!up || up.name?.toLowerCase() !== "up") return null;
  const ud = raw.variantDetails?.upDown ?? raw.variantDetails?.crypto ?? raw.variantData ?? m.variantData ?? {};
  const down = m.outcomes?.find((o) => o.indexSet === 2);
  const trading: PredictTradingInfo | null =
    up.onChainId && down?.onChainId && typeof m.feeRateBps === "number"
      ? {
          upTokenId: up.onChainId,
          downTokenId: down.onChainId,
          feeRateBps: m.feeRateBps,
          decimalPrecision: num(m.decimalPrecision) ?? 2,
          isNegRisk: m.isNegRisk === true,
          isYieldBearing: m.isYieldBearing === true,
        }
      : null;
  return { slug: raw.slug, marketId: m.id, title: raw.title ?? m.title ?? raw.slug, start, end, priceToBeat: num(ud.startPrice), closePrice: num(ud.endPrice), trading };
}

/**
 * Tokens sinteticos de un market de Predict: el sistema de motores trabaja con un token por lado (como Polymarket),
 * Predict tiene un solo libro. `4837559:up` / `4837559:down`.
 */
export const tokenOf = (marketId: number, side: "up" | "down") => `${marketId}:${side}`;
export function parseToken(token: string): { marketId: number; side: "up" | "down" } | null {
  const m = /^(\d+):(up|down)$/.exec(token);
  return m ? { marketId: Number(m[1]), side: m[2] as "up" | "down" } : null;
}

/**
 * Libro de Down a partir del de Up: comprar Down = vender Up. bids Down = 1 - asks Up, asks Down = 1 - bids Up, mismos
 * tamanos. Los niveles de entrada ya vienen ordenados (asks ascendente, bids descendente) y la salida conserva ese orden.
 */
export function mirrorBook(bids: Level[], asks: Level[]): { bids: Level[]; asks: Level[] } {
  return { bids: asks.map(([p, s]) => [round6(1 - p), s] as Level), asks: bids.map(([p, s]) => [round6(1 - p), s] as Level) };
}

/** Niveles que cambian entre dos libros completos: tamano nuevo de cada precio (0 = desaparece). */
export function diffLevels(prev: Level[], next: Level[]): Level[] {
  const before = new Map(prev.map(([p, s]) => [p, s]));
  const out: Level[] = [];
  for (const [p, s] of next) {
    if (before.get(p) !== s) out.push([p, s]);
    before.delete(p);
  }
  for (const p of before.keys()) out.push([p, 0]);
  return out;
}

/** Lee niveles `[precio, tamano]` del WS de Predict, descartando los invalidos */
export function levels(v: unknown): Level[] {
  if (!Array.isArray(v)) return [];
  const out: Level[] = [];
  for (const l of v) {
    if (!Array.isArray(l) || l.length < 2) continue;
    const p = num(l[0]);
    const s = num(l[1]);
    if (p !== null && s !== null) out.push([p, s]);
  }
  return out;
}
