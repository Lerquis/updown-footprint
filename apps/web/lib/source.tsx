"use client";

import { createContext, useContext, type ReactNode } from "react";
import { SOURCES, type MarketAsset, type MarketSource, type PmEngineId } from "@updown/protocol";
import { useStored } from "./theme";

/**
 * Activo (BTC/ETH, ADR 0018) y fuente de Binance (spot/futures, ADR 0016) que ve un panel. Todos los hooks de canal y de la API
 * los leen de aqui y piden las rutas de ese activo y esa fuente (`sourcePath`), asi los componentes valen igual para todos.
 */
interface SourceCtx {
  asset: MarketAsset;
  source: MarketSource;
}
const SourceContext = createContext<SourceCtx>({ asset: "btc", source: "spot" });

export function SourceProvider({ asset, source, children }: { asset: MarketAsset; source: MarketSource; children: ReactNode }) {
  return <SourceContext.Provider value={{ asset, source }}>{children}</SourceContext.Provider>;
}

export const useSource = (): MarketSource => useContext(SourceContext).source;
export const useAsset = (): MarketAsset => useContext(SourceContext).asset;

export const SOURCE_LABEL: Record<MarketSource, string> = { spot: "Spot", futures: "Futures" };

/**
 * Textos de cada activo. `charts`: motores con seccion de probabilidad en el grafico del market (todos si falta).
 * PRUEBA SOL: el hueco "eth" consume Solana y solo grafica el motor C (con SS encima, docs/features/sol-strength.md).
 */
export const ASSET_INFO: Record<MarketAsset, { ticker: string; name: string; pair: string; glyph: string; charts?: PmEngineId[] }> = {
  btc: { ticker: "BTC", name: "Bitcoin", pair: "BTCUSDT", glyph: "₿" },
  eth: { ticker: "ETH", name: "Ethereum", pair: "ETHUSDT", glyph: "Ξ", charts: ["c"] },
};

/** Fuente elegida para un activo, recordada en el navegador (BTC conserva la clave de siempre) */
export function useStoredSource(asset: MarketAsset): [MarketSource, (s: MarketSource) => void] {
  return useStored<MarketSource>(asset === "btc" ? "updown.source" : `updown.source.${asset}`, "spot", SOURCES);
}
