"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { SOURCES, type MarketSource } from "@updown/protocol";

/**
 * Fuente de datos de Binance que se esta viendo (spot o futures, ADR 0016). Todos los hooks de canal y de la API la leen de
 * aqui y piden las rutas de esa fuente (`sourcePath`), asi los componentes valen igual para las dos.
 */
const SourceContext = createContext<MarketSource>("spot");

export function SourceProvider({ source, children }: { source: MarketSource; children: ReactNode }) {
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>;
}

export const useSource = (): MarketSource => useContext(SourceContext);

export const SOURCE_LABEL: Record<MarketSource, string> = { spot: "Spot", futures: "Futures" };

const KEY = "updown.source";

/** Fuente elegida, recordada en el navegador (se lee tras montar: el primer render es spot, como en el servidor) */
export function useStoredSource(): [MarketSource, (s: MarketSource) => void] {
  const [source, setSource] = useState<MarketSource>("spot");
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved && (SOURCES as readonly string[]).includes(saved)) setSource(saved as MarketSource);
  }, []);
  const set = useCallback((s: MarketSource) => {
    localStorage.setItem(KEY, s);
    setSource(s);
  }, []);
  return [source, set];
}
