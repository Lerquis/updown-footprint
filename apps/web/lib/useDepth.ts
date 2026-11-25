"use client";

import { useRef, useState } from "react";
import { CHANNELS, type DepthColumn, type DepthServerMessage, type UpstreamState } from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface DepthView {
  step: number;
  /** Antiguo -> reciente */
  columns: DepthColumn[];
  link: LinkState;
  upstream: UpstreamState;
}

/** Canal /ws/depth: columnas del heatmap de liquidez (memoria = la del servidor). */
export function useDepth(): DepthView {
  const [step, setStep] = useState(1);
  const [columns, setColumns] = useState<DepthColumn[]>([]);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const retention = useRef(15 * 60_000);

  const link = useWsChannel<DepthServerMessage>(CHANNELS.depth, (msg) => {
    switch (msg.type) {
      case "snapshot":
        retention.current = msg.retentionMs;
        setStep(msg.step);
        setColumns(msg.columns);
        setUpstream(msg.upstream);
        break;
      case "column":
        setColumns((prev) => {
          const next = [...prev, msg.column];
          const cutoff = msg.column.time - retention.current;
          let drop = 0;
          while (drop < next.length && next[drop]!.time < cutoff) drop++;
          return drop ? next.slice(drop) : next;
        });
        break;
      case "status":
        setUpstream(msg.upstream);
        break;
    }
  });

  return { step, columns, link, upstream };
}
