"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "updown.theme";

/**
 * Se ejecuta en <head> antes de pintar: tema guardado o, si no hay, el del sistema. Evita el parpadeo del tema equivocado.
 * Texto plano (no se transpila): JS compatible con cualquier navegador.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${KEY}");if(t!=="light"&&t!=="dark")t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.classList.toggle("dark",t==="dark");}catch(e){document.documentElement.classList.add("dark");}})();`;

/** Tema actual (lo fijo THEME_SCRIPT) y cambio de tema, recordado en el navegador */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("dark");
  useEffect(() => {
    setThemeState(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);
  const setTheme = useCallback((t: Theme) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    localStorage.setItem(KEY, t);
    setThemeState(t);
  }, []);
  return [theme, setTheme];
}

/** Valor recordado en el navegador (se lee tras montar: el primer render usa `initial`, igual que en el servidor) */
export function useStored<T extends string>(key: string, initial: T, valid: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const saved = localStorage.getItem(key);
    if (saved !== null && (valid as readonly string[]).includes(saved)) setValue(saved as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (v: T) => {
      localStorage.setItem(key, v);
      setValue(v);
    },
    [key],
  );
  return [value, set];
}
