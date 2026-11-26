import type { PmBlock, PmDecision, PmEngineId, PmSignal } from "@updown/protocol";

/** Texto corto de cada impedimento del motor (por que no compra / vende ese lado). */
export const BLOCK_LABEL: Record<PmBlock, string> = {
  ok: "ejecuta",
  noData: "sin datos",
  flat: "sin posición",
  noQuote: "sin precio",
  warmup: "calentando",
  closing: "últimos segundos",
  maxEntries: "tope de compras",
  justSold: "acaba de vender",
  spread: "spread ancho",
  holding: "ya lo tiene",
  cooldown: "espera",
  edge: "EV bajo",
  stake: "importe mínimo/tope",
};

export const BLOCK_HELP: Record<PmBlock, string> = {
  ok: "Se cumplen todas las condiciones: el motor emite la señal.",
  noData: "Falta price to beat, Binance, basis o volatilidad: no hay probabilidad.",
  flat: "No hay tokens de ese lado: no hay nada que vender.",
  noQuote: "No hay precio útil en el libro (sin oferta, o el token ya cotiza a 0 o a 1).",
  warmup: "Primeros segundos del market: no abre posiciones.",
  closing: "Últimos segundos del market: no abre posiciones.",
  maxEntries: "Ya hizo el máximo de compras en este market.",
  justSold: "Acaba de vender ese lado en este mismo segundo.",
  spread: "El spread (ask − bid) es demasiado ancho para entrar.",
  holding: "Ya tiene tokens de ese lado (sin pirámide).",
  cooldown: "Espera tras la última señal de ese lado.",
  edge: "El valor esperado no supera el umbral.",
  stake: "El importe según Kelly es menor que el mínimo, o se agotó el tope por market.",
};

export const cents = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(0)}¢`);
export const edgeCents = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}¢`);
export const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(0)}%`);

export const signalLabel = (s: Pick<PmSignal, "action" | "side" | "price">) => `${s.action === "buy" ? "C" : "V"} ${s.side === "up" ? "Up" : "Dn"} ${cents(s.price)}`;

/** Clave de lo que hizo el motor en un segundo (para comparar A y B) */
export const actionKey = (d: PmDecision | undefined) => (d ? d.signals.map((s) => `${s.action}${s.side}`).join(",") : "");
/** Clave del estado de decision (acciones + impedimentos de cada lado) */
export const stateKey = (d: PmDecision | undefined) => (d ? `${actionKey(d)}|${d.up.buy}${d.up.sell}${d.down.buy}${d.down.sell}` : "");

/** Resultado de papel de una lista de senales con el resultado del market (null si aun no resuelve). */
export function paperNet(trades: PmSignal[], result: "up" | "down" | null): number | null {
  if (result === null) return null;
  let net = 0;
  const open = { up: 0, down: 0 };
  for (const t of trades) {
    if (t.action === "buy") {
      net -= t.amount;
      open[t.side] += t.shares;
    } else {
      net += t.amount;
      open[t.side] = Math.max(0, open[t.side] - t.shares);
    }
  }
  return Math.round((net + open[result]) * 100) / 100;
}

export const ENGINE_IDS: PmEngineId[] = ["a", "b", "c"];
/** Nombre corto y descripcion de cada motor (retrasos por defecto; el servidor envia los reales por el canal engines) */
export const ENGINE_LABEL: Record<PmEngineId, string> = { a: "Motor A", b: "Motor B", c: "Motor C" };
export const ENGINE_DESC: Record<PmEngineId, string> = {
  a: "segundo exacto, lo último recibido",
  b: "segundo + 300 ms, datos a fecha",
  c: "segundo + 150 ms, datos a fecha",
};
