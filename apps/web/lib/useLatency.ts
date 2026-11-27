"use client";

import { useState } from "react";
import { CHANNELS, type LatencySample, type LatencyServerMessage, type UpstreamState } from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface LatencyView {
  link: LinkState;
  upstream: UpstreamState;
  intervalMs: number;
  target: string;
  /** desde donde mide el servidor ("local" o region de Railway) */
  region: string;
  authReady: boolean;
  /** rondas, antiguo -> reciente */
  history: LatencySample[];
}

/** Canal /ws/latency: el servidor mide la latencia al CLOB de Polymarket cada `intervalMs` (baja frecuencia, sin rAF). */
export function useLatency(): LatencyView {
  const [view, setView] = useState<Omit<LatencyView, "link">>({
    upstream: "connecting",
    intervalMs: 15_000,
    target: "",
    region: "",
    authReady: false,
    history: [],
  });
  const [max, setMax] = useState(40);

  const link = useWsChannel<LatencyServerMessage>(CHANNELS.latency, (msg) => {
    if (msg.type === "snapshot") {
      setMax(msg.historyMax);
      setView({ upstream: msg.upstream, intervalMs: msg.intervalMs, target: msg.target, region: msg.region, authReady: msg.authReady, history: msg.history });
    } else if (msg.type === "sample") {
      setView((v) => ({ ...v, history: [...v.history, msg.sample].slice(-max) }));
    } else {
      setView((v) => ({ ...v, upstream: msg.upstream }));
    }
  });

  return { link, ...view };
}
