"use client";

import { useEffect, useRef, useState } from "react";
import { CHANNELS, type AggTrade, type AggTradesServerMessage, type UpstreamState } from "@updown/protocol";
import { exchangeClock } from "./exchangeClock";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface AggTradesView {
  symbol: string;
  /** Mas reciente primero */
  trades: AggTrade[];
  /** Memoria del servidor (ms): el cliente conserva el mismo periodo */
  retentionMs: number;
  link: LinkState;
  upstream: UpstreamState;
}

/** Quita del final (los mas viejos) lo que supera la memoria del servidor. Lista newest-first. */
function prune(list: AggTrade[], retentionMs: number): AggTrade[] {
  const cutoff = (list[0]?.time ?? 0) - retentionMs;
  let n = list.length;
  while (n > 0 && list[n - 1]!.time < cutoff) n--;
  return n === list.length ? list : list.slice(0, n);
}

/** Canal /ws/aggtrades: snapshot + trades agrupados por frame para no saturar React. */
export function useAggTrades(): AggTradesView {
  const [symbol, setSymbol] = useState("");
  const [trades, setTrades] = useState<AggTrade[]>([]);
  const [retentionMs, setRetentionMs] = useState(15 * 60_000);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const pending = useRef<AggTrade[]>([]);
  const retention = useRef(retentionMs);
  const raf = useRef(0);

  const flush = () => {
    raf.current = 0;
    const batch = pending.current;
    if (!batch.length) return;
    pending.current = [];
    setTrades((prev) => prune([...batch.reverse(), ...prev], retention.current));
  };

  const link = useWsChannel<AggTradesServerMessage>(CHANNELS.aggTrades, (msg) => {
    switch (msg.type) {
      case "snapshot":
        pending.current = [];
        retention.current = msg.retentionMs;
        setRetentionMs(msg.retentionMs);
        setSymbol(msg.symbol);
        setTrades(msg.trades.slice().reverse());
        setUpstream(msg.upstream);
        break;
      case "trade":
        exchangeClock.observe(msg.trade.time);
        pending.current.push(msg.trade);
        if (!raf.current) raf.current = requestAnimationFrame(flush);
        break;
      case "status":
        setUpstream(msg.upstream);
        break;
    }
  });

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return { symbol, trades, retentionMs, link, upstream };
}
