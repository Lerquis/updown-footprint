import { SCENARIOS, type Bias, type MatchedScenario, type ScenarioBias, type ScenarioId, type SignalType, type Trend } from "@updown/protocol";

/** Contexto que ve cada escenario: tendencias de precio y CVD + senales recientes. */
export interface ScenarioContext {
  priceTrend: Trend;
  cvdTrend: Trend;
  has(type: SignalType, bias: Bias): boolean;
}

/** Devuelve 0 si el escenario no aplica, o su importancia (1-3). */
type Test = (c: ScenarioContext) => number;

const w = (cond: boolean, weight: number) => (cond ? weight : 0);

/** Una funcion por id del catalogo (SCENARIOS en @updown/protocol). Los de "meta" se calculan despues. */
const TESTS: Record<Exclude<ScenarioId, "confluence-bullish" | "confluence-bearish" | "mixed">, Test> = {
  // Precio × CVD
  "up-confirmed": (c) => w(c.priceTrend === "up" && c.cvdTrend === "up", 1),
  "down-confirmed": (c) => w(c.priceTrend === "down" && c.cvdTrend === "down", 1),
  balance: (c) => w(c.priceTrend === "flat" && c.cvdTrend === "flat", 1),
  "up-cvd-down": (c) => w(c.priceTrend === "up" && c.cvdTrend === "down", 1),
  "down-cvd-up": (c) => w(c.priceTrend === "down" && c.cvdTrend === "up", 1),
  "up-cvd-flat": (c) => w(c.priceTrend === "up" && c.cvdTrend === "flat", 1),
  "down-cvd-flat": (c) => w(c.priceTrend === "down" && c.cvdTrend === "flat", 1),
  "flat-cvd-up": (c) => w(c.priceTrend === "flat" && c.cvdTrend === "up", 1),
  "flat-cvd-down": (c) => w(c.priceTrend === "flat" && c.cvdTrend === "down", 1),
  // Agotamiento
  "exhaustion-up-div": (c) => w(c.has("exhaustion", "bearish") && c.priceTrend === "up" && c.cvdTrend === "down", 3),
  "exhaustion-up": (c) => w(c.has("exhaustion", "bearish") && !(c.priceTrend === "up" && c.cvdTrend === "down"), 2),
  "exhaustion-down-reversal": (c) => w(c.has("exhaustion", "bullish") && c.priceTrend === "down" && c.cvdTrend === "up", 3),
  "exhaustion-down": (c) => w(c.has("exhaustion", "bullish") && !(c.priceTrend === "down" && c.cvdTrend === "up"), 2),
  // Absorcion
  "absorption-buy": (c) => w(c.has("absorption", "bullish"), c.cvdTrend === "down" ? 3 : 2),
  "absorption-sell": (c) => w(c.has("absorption", "bearish"), c.cvdTrend === "up" ? 3 : 2),
  // Desequilibrios apilados
  "stacked-buy-trend": (c) => w(c.has("stackedImbalance", "bullish") && c.priceTrend === "up", 2),
  "stacked-sell-trend": (c) => w(c.has("stackedImbalance", "bearish") && c.priceTrend === "down", 2),
  "stacked-buy-trapped": (c) => w(c.has("stackedImbalance", "bullish") && c.priceTrend !== "up", 1),
  "stacked-sell-trapped": (c) => w(c.has("stackedImbalance", "bearish") && c.priceTrend !== "down", 1),
  // Divergencias de CVD
  "cvd-div-bullish": (c) => w(c.has("cvdDivergence", "bullish"), 2),
  "cvd-div-bearish": (c) => w(c.has("cvdDivergence", "bearish"), 2),
};

const BIAS = new Map<string, ScenarioBias>(SCENARIOS.map((s) => [s.id, s.bias]));
const BASE_IDS = new Set<string>([
  "up-confirmed", "down-confirmed", "balance", "up-cvd-down", "down-cvd-up", "up-cvd-flat", "down-cvd-flat", "flat-cvd-up", "flat-cvd-down",
]);

/** Escenarios activos (el mas relevante primero), score -100..100 y sesgo global. */
export function evaluateScenarios(ctx: ScenarioContext): { scenarios: MatchedScenario[]; score: number; bias: ScenarioBias } {
  const matched: MatchedScenario[] = [];
  for (const [id, test] of Object.entries(TESTS) as [keyof typeof TESTS, Test][]) {
    const weight = test(ctx);
    if (weight > 0) matched.push({ id, weight });
  }

  // Meta: confluencia / contradiccion entre escenarios basados en senales (no en la tendencia base)
  const signalBased = matched.filter((m) => !BASE_IDS.has(m.id));
  const bull = signalBased.filter((m) => BIAS.get(m.id) === "bullish").length;
  const bear = signalBased.filter((m) => BIAS.get(m.id) === "bearish").length;
  if (bull >= 2 && bear === 0) matched.push({ id: "confluence-bullish", weight: 2 });
  if (bear >= 2 && bull === 0) matched.push({ id: "confluence-bearish", weight: 2 });
  if (bull >= 1 && bear >= 1) matched.push({ id: "mixed", weight: 1 });

  let b = 0;
  let r = 0;
  for (const m of matched) {
    const bias = BIAS.get(m.id);
    if (bias === "bullish") b += m.weight;
    else if (bias === "bearish") r += m.weight;
  }
  const score = Math.round((100 * (b - r)) / (b + r + 2));
  const bias: ScenarioBias = score >= 25 ? "bullish" : score <= -25 ? "bearish" : "neutral";

  // Orden: mayor importancia primero; a igualdad, las de senales antes que la base
  matched.sort((x, y) => y.weight - x.weight || Number(BASE_IDS.has(x.id)) - Number(BASE_IDS.has(y.id)));
  return { scenarios: matched, score, bias };
}
