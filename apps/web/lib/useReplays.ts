"use client";

import { useEffect, useState } from "react";
import type { PmReplayReport } from "@updown/protocol";
import { HTTP_BASE } from "./useWsChannel";

export type ReplaysState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; report: PmReplayReport };

/** Informe de replays del motor A con ejecucion retrasada (`GET /api/replays`, generado con `npm run replays`). */
export function useReplays(): ReplaysState {
  const [state, setState] = useState<ReplaysState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${HTTP_BASE}/api/replays`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const report = (await res.json()) as PmReplayReport;
        if (alive) setState({ status: "ready", report });
      } catch (e) {
        if (alive) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
