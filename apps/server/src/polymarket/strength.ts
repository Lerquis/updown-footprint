import type { PmPoint, PmRefPoint, PmStrengthEvent, PmStrengthSet, PmStrengthVariant } from "@updown/protocol";

/**
 * SS (Sol Strength): senales de movimiento con fuerza de la P(Up) del motor C. Solo se muestran: no generan ordenes.
 * Ver docs/features/sol-strength.md.
 *
 * Es CAUSAL: cada segundo t se decide solo con muestras <= t, igual que en vivo. La senal se marca en el segundo en que se detecta
 * (no donde empezo ni donde termino el movimiento), asi que recalcular con mas datos nunca mueve las senales pasadas.
 * 1. Ruido previo (sigma): desviacion robusta (mediana de |cambio de 1 s| x 1.4826) de los `noiseLookbackS` segundos que terminan
 *    al inicio de la ventana medida, con un suelo (`noiseFloor`) para que un tramo plano no convierta cualquier tic en un "spike".
 * 2. En el segundo t, para cada ventana `w` de `windowsS`: cambio d = p(t) - p(t - w) y su sorpresa z = |d| / (sigma * raiz(w)).
 *    Es candidato si |d| >= `minMove` y z >= `minZ`; de las ventanas que lo cumplen se queda la de mas fuerza.
 * 3. Disparo: un candidato con fuerza >= `minScore` da senal si su sentido esta "armado". Tras una senal, ese sentido se desarma
 *    hasta que el movimiento acaba (`mergeGapS` segundos sin candidatos de ese sentido), llega una senal contraria, o pasan
 *    `maxSeconds` desde la anterior (una tendencia larga vuelve a avisar).
 *    - SS Solana (calibrada): fuerza minima 35 y re-aviso a los 45 s.
 *    - SS base (sin calibrar): sin fuerza minima (avisa en cuanto se cumple el umbral) y un solo aviso por movimiento.
 * 4. Fuerza 0-100: 100 * (1 - exp(-(puntos de probabilidad x z) / `scoreScale`)). Crece con lo que recorre y con lo brusco.
 */
export interface StrengthConfig {
  windowsS: number[];
  minMove: number;
  minZ: number;
  noiseLookbackS: number;
  noiseFloor: number;
  warmupS: number;
  /** segundos sin candidatos de un sentido para darlo por terminado (y volver a armarlo) */
  mergeGapS: number;
  /** segundos tras una senal para poder repetirla en el mismo sentido sin que el movimiento haya terminado */
  maxSeconds: number;
  scoreScale: number;
  /** fuerza minima para dar la senal */
  minScore: number;
}

/** SS Solana: calibrada con los primeros markets de SOL */
export const DEFAULT_STRENGTH: StrengthConfig = {
  windowsS: [2, 3, 5, 8, 12, 20, 30],
  minMove: 0.08,
  minZ: 3,
  noiseLookbackS: 60,
  noiseFloor: 0.006,
  warmupS: 10,
  mergeGapS: 3,
  maxSeconds: 45,
  scoreScale: 120,
  minScore: 35,
};

/** SS base: la primera version, sin calibrar (avisa en cuanto se cumple el umbral, una vez por movimiento) */
export const BASE_STRENGTH: StrengthConfig = { ...DEFAULT_STRENGTH, maxSeconds: Infinity, minScore: 0 };

export const STRENGTH_CONFIGS: Record<PmStrengthVariant, StrengthConfig> = { sol: DEFAULT_STRENGTH, base: BASE_STRENGTH };

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const strengthScore = (move: number, z: number, scale = DEFAULT_STRENGTH.scoreScale): number =>
  Math.round(100 * (1 - Math.exp(-(Math.abs(move) * 100 * z) / scale)));

/** Senales SS de `pModel` en las muestras (1 s) de un motor, en el segundo en que se detectan. `start` = inicio del market. Funcion pura. */
export function detectStrength(points: PmPoint[], start: number, cfg: StrengthConfig = DEFAULT_STRENGTH): PmStrengthEvent[] {
  const s = points.filter((p) => p.pModel !== null).map((p) => ({ t: p.time, p: p.pModel! }));
  const n = s.length;
  if (n < 3) return [];
  const absDiff = s.map((x, i) => (i ? Math.abs(x.p - s[i - 1]!.p) : 0));
  // sigma del ruido que termina en j (los cambios de 1 s de los `noiseLookbackS` anteriores): solo pasado
  const sigma = s.map((_, j) => Math.max(cfg.noiseFloor, 1.4826 * median(absDiff.slice(Math.max(1, j - cfg.noiseLookbackS + 1), j + 1))));

  const state = { up: { cand: -Infinity, sig: -Infinity, fired: false }, down: { cand: -Infinity, sig: -Infinity, fired: false } };
  const events: PmStrengthEvent[] = [];
  for (let i = 1; i < n; i++) {
    const t = s[i]!.t;
    // mejor ventana que termina en este segundo (solo muestras <= t)
    let best: { j: number; d: number; z: number; score: number } | null = null;
    for (const w of cfg.windowsS) {
      const j = i - w;
      if (j < 0) break;
      // muestras de 1 s: si hay un hueco, la ventana no mide lo que dice
      if (t - s[j]!.t > (w + 2) * 1000) continue;
      if (s[j]!.t < start + cfg.warmupS * 1000) continue;
      const d = s[i]!.p - s[j]!.p;
      if (Math.abs(d) < cfg.minMove) continue;
      const z = Math.abs(d) / (sigma[j]! * Math.sqrt(Math.max(1, (t - s[j]!.t) / 1000)));
      if (z < cfg.minZ) continue;
      const score = strengthScore(d, z, cfg.scoreScale);
      if (!best || score > best.score) best = { j, d, z, score };
    }
    // un sentido sin candidatos durante `mergeGapS` = su movimiento termino: se vuelve a armar
    for (const st of [state.up, state.down]) if (t - st.cand > cfg.mergeGapS * 1000) st.fired = false;
    if (!best) continue;
    const dir = best.d > 0 ? "up" : "down";
    const st = state[dir];
    st.cand = t;
    if (best.score < cfg.minScore) continue;
    if (st.fired && t - st.sig < cfg.maxSeconds * 1000) continue;
    st.fired = true;
    st.sig = t;
    state[dir === "up" ? "down" : "up"].fired = false;
    events.push({
      time: t,
      dir,
      p: s[i]!.p,
      from: s[best.j]!.p,
      move: best.d,
      seconds: Math.round((t - s[best.j]!.t) / 1000),
      z: Math.round(best.z * 10) / 10,
      score: best.score,
    });
  }
  return events;
}

/** SS de todas las variantes. Funcion pura. */
export function detectStrengthSet(points: PmPoint[], start: number): PmStrengthSet {
  return { sol: detectStrength(points, start, STRENGTH_CONFIGS.sol), base: detectStrength(points, start, STRENGTH_CONFIGS.base) };
}

/** Token Up de la referencia (BTC) al dar la senal y su cambio en la misma ventana (muestra mas cercana a cada extremo, +-3 s). Funcion pura. */
export function withRefMove(events: PmStrengthEvent[], ref: PmRefPoint[]): PmStrengthEvent[] {
  const pts = ref.filter((p) => p.up !== null);
  if (!pts.length) return events;
  const at = (t: number) => {
    const p = pts.reduce((best, x) => (Math.abs(x.time - t) < Math.abs(best.time - t) ? x : best), pts[0]!);
    return Math.abs(p.time - t) <= 3000 ? p.up! : null;
  };
  return events.map((e) => {
    const b = at(e.time);
    const a = at(e.time - e.seconds * 1000);
    return { ...e, refUp: b, refUpMove: a !== null && b !== null ? b - a : null };
  });
}

/** Mitad del spread de un token (bid y ask, o el que haya) */
export const tokenMid = (bid: number | null, ask: number | null): number | null => (bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask));
