import type { Bias, ScenarioBias, SignalType, Trend } from "@updown/protocol";

/** Textos y colores compartidos por la grafica, los paneles y la guia. */
export const SIGNAL_INFO: Record<SignalType, { label: string; short: string; desc: string }> = {
  stackedImbalance: {
    label: "Desequilibrio apilado",
    short: "IMB",
    desc: "3 o más niveles de precio seguidos donde un lado (compradores o vendedores agresivos) supera al otro al menos 3 a 1 en diagonal. Indica empuje sostenido de un lado.",
  },
  absorption: {
    label: "Absorción",
    short: "ABS",
    desc: "Mucho volumen agresivo en un extremo de la barra y aun así el precio no avanza: una orden pasiva grande lo absorbe. Compradora en mínimos, vendedora en máximos.",
  },
  exhaustion: {
    label: "Agotamiento",
    short: "AGOT",
    desc: "La barra hace un nuevo máximo (o mínimo) pero con casi nada de volumen en el extremo y fuerza decreciente: el movimiento se queda sin combustible.",
  },
  cvdDivergence: {
    label: "Divergencia de CVD",
    short: "DIV",
    desc: "El precio marca un nuevo máximo (mínimo) pero el CVD no lo confirma: hace un máximo más bajo (mínimo más alto). La presión de ese lado se debilita.",
  },
};

export const BUY_RGB = "14,203,129";
export const SELL_RGB = "246,70,93";
export const biasRgb = (b: Bias) => (b === "bullish" ? BUY_RGB : SELL_RGB);
export const biasArrow = (b: Bias) => (b === "bullish" ? "▲" : "▼");

export const BIAS_LABEL: Record<ScenarioBias, string> = { bullish: "Alcista", bearish: "Bajista", neutral: "Neutral" };
export const biasText = (b: ScenarioBias) => (b === "bullish" ? "text-buy" : b === "bearish" ? "text-sell" : "text-muted-foreground");

export const TREND_LABEL: Record<Trend, string> = { up: "sube", down: "baja", flat: "plano" };
export const trendArrow = (t: Trend) => (t === "up" ? "↑" : t === "down" ? "↓" : "→");

export const fmtClockHM = (ms: number) => new Date(ms).toLocaleTimeString("es", { hour12: false, hour: "2-digit", minute: "2-digit" });
/** Dia y mes cortos (hora local), p. ej. "25/11" */
export const fmtDayShort = (ms: number) => new Date(ms).toLocaleDateString("es", { day: "2-digit", month: "2-digit" });
export const fmtClockHMS =(ms: number) => new Date(ms).toLocaleTimeString("es", { hour12: false });
