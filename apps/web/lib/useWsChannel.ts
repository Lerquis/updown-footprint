"use client";

import { useEffect, useRef, useState } from "react";

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";
/** Misma direccion del servidor para su API HTTP (`/api/...`) */
export const HTTP_BASE = WS_BASE.replace(/^ws/, "http");

export type LinkState = "connecting" | "open" | "closed";

/**
 * Conexion a un canal WS del servidor con reconexion exponencial.
 * `onMessage` puede cambiar entre renders sin reconectar. Devuelve el estado del enlace.
 * Con `path` null no se conecta (canales que solo se piden bajo demanda, p. ej. al abrir un panel).
 */
export function useWsChannel<T>(path: string | null, onMessage: (msg: T) => void): LinkState {
  const [link, setLink] = useState<LinkState>("connecting");
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (path === null) {
      setLink("closed");
      return;
    }
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      setLink("connecting");
      ws = new WebSocket(`${WS_BASE}${path}`);
      ws.onopen = () => {
        attempt = 0;
        setLink("open");
      };
      ws.onmessage = (ev) => handler.current(JSON.parse(ev.data as string) as T);
      ws.onclose = () => {
        if (disposed) return;
        setLink("closed");
        retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [path]);

  return link;
}
