"use client";

import { useRef, useState } from "react";
import {
  CHANNELS,
  type CvdPoint,
  type FootprintBar,
  type OrderflowSignal,
  type PmMarket,
  type PmPoint,
  type PmRecord,
  type PmSignal,
  type PolymarketServerMessage,
  type UpstreamState,
} from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

export interface PolymarketView {
  current: PmMarket | null;
  next: PmMarket | null;
  /** muestras de 1 s del market en curso */
  points: PmPoint[];
  /** senales del motor del market en curso */
  trades: PmSignal[];
  /** terminados, antiguo -> reciente */
  history: PmRecord[];
  link: LinkState;
  upstream: UpstreamState;
}

/** Canal /ws/polymarket: market BTC Up/Down en curso, precios en vivo e historial de markets terminados. */
export function usePolymarket(): PolymarketView {
  const [current, setCurrent] = useState<PmMarket | null>(null);
  const [next, setNext] = useState<PmMarket | null>(null);
  const [points, setPoints] = useState<PmPoint[]>([]);
  const [trades, setTrades] = useState<PmSignal[]>([]);
  const [history, setHistory] = useState<PmRecord[]>([]);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const curStart = useRef(0);

  const link = useWsChannel<PolymarketServerMessage>(CHANNELS.polymarket, (msg) => {
    switch (msg.type) {
      case "snapshot":
        curStart.current = msg.current?.start ?? 0;
        setCurrent(msg.current);
        setNext(msg.next);
        setPoints(msg.points);
        setTrades(msg.trades);
        setHistory(msg.history);
        setUpstream(msg.upstream);
        break;
      case "markets":
        // al rotar, los puntos del market anterior ya no aplican
        if (msg.current && msg.current.start !== curStart.current) {
          setPoints([]);
          setTrades([]);
        }
        curStart.current = msg.current?.start ?? 0;
        setCurrent(msg.current);
        setNext(msg.next);
        break;
      case "point":
        setPoints((prev) => [...prev, msg.point].slice(-400));
        break;
      case "signal":
        setTrades((prev) => (prev.some((t) => t.id === msg.signal.id) ? prev : [...prev, msg.signal]));
        break;
      case "record":
        setHistory((prev) => {
          const i = prev.findIndex((r) => r.market.slug === msg.record.market.slug);
          if (i >= 0) {
            const copy = prev.slice();
            copy[i] = msg.record;
            return copy;
          }
          return [...prev, msg.record].sort((a, b) => a.market.start - b.market.start).slice(-60);
        });
        break;
      case "status":
        setUpstream(msg.upstream);
        break;
    }
  });

  return { current, next, points, trades, history, link, upstream };
}

/** Recorta el flujo de Binance (ya en el navegador) a la ventana del market en curso. */
export function sliceFlow(
  m: PmMarket,
  flow: { bars: FootprintBar[]; cvd: CvdPoint[]; signals: OrderflowSignal[] },
): Pick<PmRecord, "bars" | "cvd" | "signals"> {
  return {
    bars: flow.bars.filter((b) => b.start >= m.start && b.start < m.end),
    cvd: flow.cvd.filter((p) => p.time > m.start && p.time <= m.end),
    signals: flow.signals.filter((s) => s.barStart >= m.start && s.barStart < m.end),
  };
}

/** Mitad del spread de un token: probabilidad implícita. */
export const mid = (bid: number | null, ask: number | null): number | null =>
  bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);

