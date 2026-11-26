"use client";

import { useEffect, useRef, useState } from "react";
import { CHANNELS, type EnginesServerMessage, type PmDecision, type PmEngineId, type PmEngineMarket, type PmEngineThresholds, type PmSignal } from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface EngineTrack {
  /** market de las decisiones (cada motor rota por su cuenta) */
  slug: string | null;
  decisions: PmDecision[];
  /** operaciones del market en curso (sacadas de las decisiones) */
  trades: PmSignal[];
}

export interface EnginesView {
  link: LinkState;
  thresholds: PmEngineThresholds | null;
  syncDelayMs: number;
  a: EngineTrack;
  b: EngineTrack;
  /** operaciones del motor B en los markets terminados recientes, antiguo -> reciente */
  bHistory: PmEngineMarket[];
}

const EMPTY: EngineTrack = { slug: null, decisions: [], trades: [] };
const MAX_DECISIONS = 330; // un market de 5 min (1 por s) + margen
const MAX_HISTORY = 48;

const track = (slug: string | null, decisions: PmDecision[]): EngineTrack => ({ slug, decisions, trades: decisions.flatMap((d) => d.signals) });

/**
 * Canal /ws/engines (decisiones de los motores A y B). Solo se conecta con `enabled` (drawer abierto o motor B en el
 * grafico): fuera de eso no consume red ni CPU. Los deltas (2 por segundo) se vuelcan a estado una vez por frame.
 */
export function useEngines(enabled: boolean): EnginesView {
  const [view, setView] = useState<Omit<EnginesView, "link">>({ thresholds: null, syncDelayMs: 0, a: EMPTY, b: EMPTY, bHistory: [] });
  const pending = useRef<EnginesServerMessage[]>([]);
  const frame = useRef(0);

  const flush = () => {
    frame.current = 0;
    const msgs = pending.current;
    pending.current = [];
    setView((prev) => {
      const next = { ...prev, a: prev.a, b: prev.b, bHistory: prev.bHistory };
      const lists: Record<PmEngineId, { slug: string | null; decisions: PmDecision[]; dirty: boolean }> = {
        a: { slug: prev.a.slug, decisions: prev.a.decisions, dirty: false },
        b: { slug: prev.b.slug, decisions: prev.b.decisions, dirty: false },
      };
      for (const m of msgs) {
        if (m.type === "snapshot") {
          next.thresholds = m.thresholds;
          next.syncDelayMs = m.syncDelayMs;
          next.bHistory = m.bHistory;
          lists.a = { slug: m.slug, decisions: m.a, dirty: true };
          lists.b = { slug: m.b.length ? m.slug : null, decisions: m.b, dirty: true };
        } else if (m.type === "decision") {
          const l = lists[m.engine];
          if (l.slug !== m.slug) lists[m.engine] = { slug: m.slug, decisions: [m.decision], dirty: true };
          else {
            if (!l.dirty) l.decisions = l.decisions.slice();
            l.decisions.push(m.decision);
            if (l.decisions.length > MAX_DECISIONS) l.decisions.shift();
            l.dirty = true;
          }
        } else if (m.type === "bMarket") {
          next.bHistory = [...next.bHistory.filter((h) => h.slug !== m.market.slug), m.market].slice(-MAX_HISTORY);
        }
      }
      if (lists.a.dirty) next.a = track(lists.a.slug, lists.a.decisions);
      if (lists.b.dirty) next.b = track(lists.b.slug, lists.b.decisions);
      return next;
    });
  };

  const link = useWsChannel<EnginesServerMessage>(enabled ? CHANNELS.engines : null, (msg) => {
    pending.current.push(msg);
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  });

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { link, ...view };
}
