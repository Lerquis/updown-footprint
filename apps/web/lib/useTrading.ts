"use client";

import { useCallback, useState } from "react";
import { CHANNELS, type LiveTrade, type LiveTradingState, type TradingArmRequest, type TradingServerMessage } from "@updown/protocol";
import { HTTP_BASE, useWsChannel, type LinkState } from "./useWsChannel";

const PASS_KEY = "updown.tradingPassword";

export interface TradingView {
  link: LinkState;
  state: LiveTradingState | null;
  /** operaciones reales del market activado, antiguo -> reciente */
  trades: LiveTrade[];
  /** activar/desactivar en el market en curso; devuelve un error legible o null */
  setArmed: (slug: string, armed: boolean, password?: string) => Promise<string | null>;
  /** hay contrasena guardada en este navegador */
  hasPassword: boolean;
  forgetPassword: () => void;
}

/** Canal /ws/trading (compras reales del motor C) + interruptor por HTTP con contrasena (guardada en este navegador). */
export function useTrading(): TradingView {
  const [state, setState] = useState<LiveTradingState | null>(null);
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [hasPassword, setHasPassword] = useState(() => typeof window !== "undefined" && !!localStorage.getItem(PASS_KEY));

  const link = useWsChannel<TradingServerMessage>(CHANNELS.trading, (msg) => {
    if (msg.type === "snapshot") {
      setState(msg.state);
      setTrades(msg.trades);
    } else if (msg.type === "state") {
      setState((prev) => {
        // al activar en otro market el servidor empieza de cero: vaciar la lista
        if (prev && msg.state.armedSlug && msg.state.armedSlug !== prev.armedSlug) setTrades([]);
        return msg.state;
      });
    } else {
      setTrades((t) => [...t, msg.trade].slice(-50));
    }
  });

  const setArmed = useCallback(async (slug: string, armed: boolean, password?: string) => {
    const pass = password ?? localStorage.getItem(PASS_KEY) ?? "";
    if (!pass) return "falta la contraseña";
    try {
      const body: TradingArmRequest = { slug, armed };
      const r = await fetch(`${HTTP_BASE}/api/trading/arm`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trading-password": pass },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; state?: LiveTradingState };
      if (r.status === 401) {
        localStorage.removeItem(PASS_KEY);
        setHasPassword(false);
        return "contraseña incorrecta";
      }
      localStorage.setItem(PASS_KEY, pass);
      setHasPassword(true);
      if (j.state) setState(j.state);
      return r.ok ? null : (j.error ?? `error ${r.status}`);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);

  const forgetPassword = useCallback(() => {
    localStorage.removeItem(PASS_KEY);
    setHasPassword(false);
  }, []);

  return { link, state, trades, setArmed, hasPassword, forgetPassword };
}
