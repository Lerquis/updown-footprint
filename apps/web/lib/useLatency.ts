"use client";

import { useCallback, useState } from "react";
import {
  CHANNELS,
  type LatencySample,
  type LatencyServerMessage,
  type MakerProbeRequest,
  type MakerProbeSample,
  type MakerProbeState,
  type LiveEngine,
  type UpstreamState,
} from "@updown/protocol";
import { PASS_KEY } from "./useTrading";
import { HTTP_BASE, useWsChannel, type LinkState } from "./useWsChannel";

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
  /** check maker: ordenes maker reales siguiendo a un motor */
  maker: { state: MakerProbeState | null; history: MakerProbeSample[] };
  /** activar/desactivar el check maker con el motor a seguir (contrasena de trading guardada o la dada); devuelve un error legible o null */
  setMaker: (enabled: boolean, password?: string, engine?: LiveEngine) => Promise<string | null>;
}

/** Canal /ws/latency: el servidor mide la latencia al CLOB de Polymarket cada `intervalMs` (baja frecuencia, sin rAF). */
export function useLatency(): LatencyView {
  const [view, setView] = useState<Omit<LatencyView, "link" | "setMaker">>({
    upstream: "connecting",
    intervalMs: 15_000,
    target: "",
    region: "",
    authReady: false,
    history: [],
    maker: { state: null, history: [] },
  });
  const [max, setMax] = useState(40);

  const link = useWsChannel<LatencyServerMessage>(CHANNELS.latency, (msg) => {
    if (msg.type === "snapshot") {
      setMax(msg.historyMax);
      setView({
        upstream: msg.upstream,
        intervalMs: msg.intervalMs,
        target: msg.target,
        region: msg.region,
        authReady: msg.authReady,
        history: msg.history,
        maker: msg.maker ?? { state: null, history: [] },
      });
    } else if (msg.type === "sample") {
      setView((v) => ({ ...v, history: [...v.history, msg.sample].slice(-max) }));
    } else if (msg.type === "makerSample") {
      // upsert por senal
      setView((v) => ({ ...v, maker: { ...v.maker, history: [...v.maker.history.filter((x) => x.signalId !== msg.sample.signalId), msg.sample].slice(-60) } }));
    } else if (msg.type === "makerState") {
      setView((v) => ({ ...v, maker: { ...v.maker, state: msg.state } }));
    } else {
      setView((v) => ({ ...v, upstream: msg.upstream }));
    }
  });

  const setMaker = useCallback(async (enabled: boolean, password?: string, engine?: LiveEngine) => {
    const pass = password ?? localStorage.getItem(PASS_KEY) ?? "";
    if (!pass) return "falta la contraseña";
    try {
      const body: MakerProbeRequest = { enabled, engine };
      const r = await fetch(`${HTTP_BASE}/api/latency/maker`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trading-password": pass },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; state?: MakerProbeState };
      if (r.status === 401) {
        localStorage.removeItem(PASS_KEY);
        return "contraseña incorrecta";
      }
      localStorage.setItem(PASS_KEY, pass);
      if (j.state) setView((v) => ({ ...v, maker: { ...v.maker, state: j.state! } }));
      return r.ok ? null : (j.error ?? `error ${r.status}`);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);

  return { link, ...view, setMaker };
}
