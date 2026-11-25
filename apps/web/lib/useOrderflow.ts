"use client";

import { useRef, useState } from "react";
import {
  CHANNELS,
  type CvdPoint,
  type FootprintBar,
  type OrderflowServerMessage,
  type OrderflowSignal,
  type UpstreamState,
} from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface OrderflowView {
  tick: number;
  barMs: number;
  retentionMs: number;
  /** Antiguo -> reciente; la ultima puede estar en formacion (`closed: false`) */
  bars: FootprintBar[];
  /** Antiguo -> reciente */
  cvd: CvdPoint[];
  signals: OrderflowSignal[];
  link: LinkState;
  upstream: UpstreamState;
}

/** Canal /ws/orderflow: barras footprint, CVD y senales. */
export function useOrderflow(): OrderflowView {
  const [meta, setMeta] = useState({ tick: 1, barMs: 60_000, retentionMs: 15 * 60_000 });
  const [bars, setBars] = useState<FootprintBar[]>([]);
  const [cvd, setCvd] = useState<CvdPoint[]>([]);
  const [signals, setSignals] = useState<OrderflowSignal[]>([]);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const retention = useRef(meta.retentionMs);

  const link = useWsChannel<OrderflowServerMessage>(CHANNELS.orderflow, (msg) => {
    switch (msg.type) {
      case "snapshot":
        retention.current = msg.retentionMs;
        setMeta({ tick: msg.tick, barMs: msg.barMs, retentionMs: msg.retentionMs });
        setBars(msg.bars);
        setCvd(msg.cvd);
        setSignals(msg.signals);
        setUpstream(msg.upstream);
        break;
      case "bar":
        setBars((prev) => {
          // la barra en formacion se reemplaza por `start`; las cerradas quedan
          const i = prev.findIndex((b) => b.start === msg.bar.start);
          if (i >= 0) {
            const next = prev.slice();
            next[i] = msg.bar;
            return next;
          }
          return [...prev, msg.bar].sort((a, b) => a.start - b.start).slice(-120);
        });
        break;
      case "cvd":
        setCvd((prev) => {
          const next = [...prev, msg.point];
          const cutoff = msg.point.time - retention.current;
          let drop = 0;
          while (drop < next.length && next[drop]!.time < cutoff) drop++;
          return drop ? next.slice(drop) : next;
        });
        break;
      case "signal":
        setSignals((prev) => (prev.some((s) => s.id === msg.signal.id) ? prev : [...prev, msg.signal].slice(-300)));
        break;
      case "status":
        setUpstream(msg.upstream);
        break;
    }
  });

  return { ...meta, bars, cvd, signals, link, upstream };
}
