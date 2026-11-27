"use client";

import { useEffect, useState } from "react";
import type { CompareResponse } from "@updown/protocol";
import { HTTP_BASE } from "./useWsChannel";

export type CompareState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: CompareResponse };

/** Comparativa spot vs futures de los markets guardados por las dos fuentes (`GET /api/compare`). Se refresca cada minuto. */
export function useCompare(limit: number): CompareState {
  const [state, setState] = useState<CompareState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${HTTP_BASE}/api/compare?limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CompareResponse;
        if (alive) setState({ status: "ready", data });
      } catch (e) {
        if (alive) setState((s) => (s.status === "ready" ? s : { status: "error", message: e instanceof Error ? e.message : String(e) }));
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [limit]);
  return state;
}
