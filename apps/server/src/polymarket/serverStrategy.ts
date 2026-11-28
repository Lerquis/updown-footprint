import { config } from "../config.js";
import { DEFAULT_MODEL, type FeeKind } from "./model.js";
import { DEFAULT_STRATEGY, type StrategyConfig } from "./strategy.js";

/**
 * Mercado de prediccion al que se aplican los motores. Mismas reglas y umbrales; cambian como se resuelve y la comision:
 * polymarket = TWAP de 60 s de Chainlink, comision feeRate·p·(1-p) · predict = precio puntual de Chainlink (sin TWAP; el basis
 * se mide contra una media corta de Binance), comision feeRate·min(p, 1-p). Ver docs/features/predict-markets.md.
 */
export type Venue = "polymarket" | "predict";

/** Lo que cambia por mercado: ventana TWAP, ventana del basis y comision */
function venueModel(venue: Venue): { twapSeconds: number; basisSeconds: number; feeRate: number; feeKind: FeeKind } {
  return venue === "predict"
    ? { twapSeconds: 0, basisSeconds: config.predict.basisSeconds, feeRate: config.predict.feeRate, feeKind: "min" }
    : { twapSeconds: config.pmTwapSeconds, basisSeconds: config.pmTwapSeconds, feeRate: config.pmFeeRate, feeKind: "pq" };
}

/** Configuracion efectiva del motor de senales segun las variables PM_* (la que usan el servidor y los replays). */
export function serverStrategy(venue: Venue = "polymarket"): StrategyConfig {
  const v = venueModel(venue);
  return {
    ...DEFAULT_STRATEGY,
    model: { ...DEFAULT_MODEL, modelWeight: config.pmModelWeight, flowGain: config.pmFlowGain, twapSeconds: v.twapSeconds, basisSeconds: v.basisSeconds },
    feeRate: v.feeRate,
    feeKind: v.feeKind,
    slippage: config.pmSlippage,
    minEdge: config.pmMinEdge,
    exitMargin: config.pmExitMargin,
    bankroll: config.pmBankroll,
    kellyFraction: config.pmKellyFraction,
    maxStakePct: config.pmMaxStakePct,
    maxMarketPct: config.pmMaxMarketPct,
    warmupS: config.pmWarmupS,
    noEntryS: config.pmNoEntryS,
  };
}
