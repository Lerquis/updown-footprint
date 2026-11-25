"use client";

import { useState } from "react";
import { CHANNELS, type AnalysisServerMessage, type MarketSummary, type UpstreamState } from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface AnalysisView {
  summary: MarketSummary | null;
  /** Cambios de lectura, el mas reciente al final */
  history: MarketSummary[];
  link: LinkState;
  upstream: UpstreamState;
}

/** Canal /ws/analysis: lectura actual del monitor de escenarios + registro de cambios. */
export function useAnalysis(): AnalysisView {
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [history, setHistory] = useState<MarketSummary[]>([]);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");

  const link = useWsChannel<AnalysisServerMessage>(CHANNELS.analysis, (msg) => {
    switch (msg.type) {
      case "snapshot":
        setSummary(msg.summary);
        setHistory(msg.history);
        setUpstream(msg.upstream);
        break;
      case "summary":
        setSummary(msg.summary);
        break;
      case "change":
        setHistory((prev) => [...prev, msg.summary].slice(-50));
        break;
      case "status":
        setUpstream(msg.upstream);
        break;
    }
  });

  return { summary, history, link, upstream };
}
