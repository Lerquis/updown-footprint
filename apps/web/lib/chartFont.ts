const FALLBACK = "ui-monospace, Consolas, monospace";

/** Familia monoespaciada de la pagina (JetBrains Mono de next/font, variable `--font-mono`) para el texto de los canvas */
export function chartMono(): string {
  if (typeof document === "undefined") return FALLBACK;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return v ? `${v}, ${FALLBACK}` : FALLBACK;
}
