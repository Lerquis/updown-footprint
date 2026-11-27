"use client";

import { useEffect, useRef, useState } from "react";
import { CHANNELS, type EnginesServerMessage, type PmDecision, type PmEngineId, type PmEngineInfo, type PmEngineThresholds, type PmSignal } from "@updown/protocol";
import { ENGINE_IDS } from "./engines";
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
  /** como decide cada motor (modo y retraso) */
  info: PmEngineInfo[];
  tracks: Record<PmEngineId, EngineTrack>;
}

const EMPTY: EngineTrack = { slug: null, decisions: [], trades: [] };
const MAX_DECISIONS = 330; // un market de 5 min (1 por s) + margen
const IDS: PmEngineId[] = ENGINE_IDS;

const track = (slug: string | null, decisions: PmDecision[]): EngineTrack => ({ slug, decisions, trades: decisions.flatMap((d) => d.signals) });

/**
 * Canal /ws/engines (decisiones de los motores A, C, D y E). Solo se conecta con `enabled` (drawer abierto):
 * fuera de eso no consume red ni CPU. Los deltas (4 por segundo) se vuelcan a estado una vez por frame.
 */
export function useEngines(enabled: boolean, channel: string = CHANNELS.engines): EnginesView {
  const [view, setView] = useState<Omit<EnginesView, "link">>({ thresholds: null, info: [], tracks: { a: EMPTY, c: EMPTY, d: EMPTY, e: EMPTY } });
  const pending = useRef<EnginesServerMessage[]>([]);
  const frame = useRef(0);

  const flush = () => {
    frame.current = 0;
    const msgs = pending.current;
    pending.current = [];
    setView((prev) => {
      const next = { ...prev };
      const lists = Object.fromEntries(IDS.map((id) => [id, { slug: prev.tracks[id].slug, decisions: prev.tracks[id].decisions, dirty: false }])) as Record<
        PmEngineId,
        { slug: string | null; decisions: PmDecision[]; dirty: boolean }
      >;
      for (const m of msgs) {
        if (m.type === "snapshot") {
          next.thresholds = m.thresholds;
          next.info = m.engines;
          for (const id of IDS) lists[id] = { slug: m.decisions[id]?.slug ?? null, decisions: m.decisions[id]?.decisions ?? [], dirty: true };
        } else {
          const l = lists[m.engine];
          if (l.slug !== m.slug) lists[m.engine] = { slug: m.slug, decisions: [m.decision], dirty: true };
          else {
            if (!l.dirty) l.decisions = l.decisions.slice();
            l.decisions.push(m.decision);
            if (l.decisions.length > MAX_DECISIONS) l.decisions.shift();
            l.dirty = true;
          }
        }
      }
      next.tracks = { ...prev.tracks };
      for (const id of IDS) if (lists[id].dirty) next.tracks[id] = track(lists[id].slug, lists[id].decisions);
      return next;
    });
  };

  const link = useWsChannel<EnginesServerMessage>(enabled ? channel : null, (msg) => {
    pending.current.push(msg);
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  });

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { link, ...view };
}
