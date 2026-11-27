"use client";

import { useCallback, useEffect, useState } from "react";
import type { PmMarketRow, PmMarketsResponse, PmRecord } from "@updown/protocol";
import { useApiUrl } from "./useWsChannel";

export interface MarketRows {
  /** todos los markets guardados en la base de datos, mas recientes primero */
  rows: PmMarketRow[];
  total: number;
  loading: boolean;
  error: string | null;
}

/**
 * Tabla de markets desde la API del servidor (`GET /api/markets`), no desde la memoria del canal WS:
 * trae todos los markets guardados. Se vuelve a pedir cuando cambia `refreshKey` (p. ej. al cerrar un market) y cada minuto.
 */
export function useMarketRows(refreshKey: string | number, base = "/api/markets"): MarketRows {
  const [state, setState] = useState<MarketRows>({ rows: [], total: 0, loading: true, error: null });
  const apiUrl = useApiUrl();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(apiUrl(`${base}?order=desc`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as PmMarketsResponse;
        if (!cancelled) setState({ rows: body.markets, total: body.total, loading: false, error: null });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "error" }));
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey, apiUrl, base]);

  return state;
}

/** Pide un market guardado completo (points, barras, CVD, senales, operaciones). */
export function useFetchRecord(base = "/api/markets") {
  const apiUrl = useApiUrl();
  return useCallback(
    async (slug: string): Promise<PmRecord | null> => {
      const res = await fetch(apiUrl(`${base}/${encodeURIComponent(slug)}`));
      return res.ok ? ((await res.json()) as PmRecord) : null;
    },
    [apiUrl, base],
  );
}
