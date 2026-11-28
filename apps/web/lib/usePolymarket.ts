"use client";

import { useRef, useState } from "react";
import {
  CHANNELS,
  type CvdPoint,
  type FootprintBar,
  type OrderflowSignal,
  type PmMarket,
  type PmPoint,
  type PmSecondaryEngineId,
  type PmRecord,
  type PmRef,
  type PmSignal,
  type PmStrengthSet,
  type PolymarketServerMessage,
  type UpstreamState,
} from "@updown/protocol";
import { useWsChannel, type LinkState } from "./useWsChannel";

/** Muestras y senales de un motor en el market en curso */
export interface EngineLive {
  points: PmPoint[];
  trades: PmSignal[];
}
const EMPTY_LIVE: EngineLive = { points: [], trades: [] };
const EMPTY_ENGINES: Record<PmSecondaryEngineId, EngineLive> = { c: EMPTY_LIVE };

export interface PolymarketView {
  current: PmMarket | null;
  next: PmMarket | null;
  /** muestras de 1 s del motor A en el market en curso */
  points: PmPoint[];
  /** senales del motor A del market en curso */
  trades: PmSignal[];
  /** motor C en el market en curso */
  engines: Record<PmSecondaryEngineId, EngineLive>;
  /** terminados, antiguo -> reciente */
  history: PmRecord[];
  /** SS y precio de referencia (BTC) del market en curso; vacios si la fuente no tiene SS */
  strength: PmStrengthSet | null;
  reference: PmRef | null;
  link: LinkState;
  upstream: UpstreamState;
}

/**
 * Canal /ws/polymarket: market BTC Up/Down en curso, precios en vivo e historial de markets terminados.
 * `channel`: el de Predict (`CHANNELS.predict`) usa los mismos mensajes.
 */
export function usePolymarket(channel: string = CHANNELS.polymarket): PolymarketView {
  const [current, setCurrent] = useState<PmMarket | null>(null);
  const [next, setNext] = useState<PmMarket | null>(null);
  const [points, setPoints] = useState<PmPoint[]>([]);
  const [trades, setTrades] = useState<PmSignal[]>([]);
  const [engines, setEngines] = useState<Record<PmSecondaryEngineId, EngineLive>>(EMPTY_ENGINES);
  const [history, setHistory] = useState<PmRecord[]>([]);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const [strength, setStrength] = useState<PmStrengthSet | null>(null);
  const [reference, setReference] = useState<PmRef | null>(null);
  const curStart = useRef(0);
  const curSlug = useRef("");

  const link = useWsChannel<PolymarketServerMessage>(channel, (msg) => {
    switch (msg.type) {
      case "snapshot":
        curStart.current = msg.current?.start ?? 0;
        curSlug.current = msg.current?.slug ?? "";
        setCurrent(msg.current);
        setNext(msg.next);
        setStrength(msg.strength ?? null);
        setReference(msg.ref ?? null);
        setPoints(msg.points);
        setTrades(msg.trades);
        setEngines({ ...EMPTY_ENGINES, ...msg.engines });
        setHistory(msg.history);
        setUpstream(msg.upstream);
        break;
      case "markets":
        // al rotar, los puntos del market anterior ya no aplican
        if (msg.current && msg.current.start !== curStart.current) {
          setPoints([]);
          setTrades([]);
          setEngines(EMPTY_ENGINES);
          setStrength(null);
          setReference(null);
        }
        curStart.current = msg.current?.start ?? 0;
        curSlug.current = msg.current?.slug ?? "";
        setCurrent(msg.current);
        setNext(msg.next);
        break;
      case "point": {
        const add = (prev: PmPoint[]) => [...prev, msg.point].slice(-400);
        if (msg.engine === "a") setPoints(add);
        else {
          const id = msg.engine;
          setEngines((prev) => ({ ...prev, [id]: { ...prev[id], points: add(prev[id].points) } }));
        }
        break;
      }
      case "signal": {
        const add = (prev: PmSignal[]) => (prev.some((t) => t.id === msg.signal.id) ? prev : [...prev, msg.signal]);
        if (msg.engine === "a") setTrades(add);
        else {
          const id = msg.engine;
          setEngines((prev) => ({ ...prev, [id]: { ...prev[id], trades: add(prev[id].trades) } }));
        }
        break;
      }
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
      case "strength":
        if (msg.slug === curSlug.current) setStrength(msg.strength);
        break;
      case "ref": {
        if (msg.slug !== curSlug.current) break;
        const pt = msg.point;
        setReference((prev) => ({ label: msg.label, points: [...(prev?.points ?? []).filter((p) => p.time !== pt.time), pt].slice(-400) }));
        break;
      }
      case "status":
        setUpstream(msg.upstream);
        break;
    }
  });

  return { current, next, points, trades, engines, history, strength, reference, link, upstream };
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

