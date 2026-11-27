import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import { DEFAULT_MAKER, type MakerConfig } from "./maker.js";
import { DEFAULT_DRIFT, MICRO_FEATURES, type DriftConfig, type MicroVector } from "./micro.js";
import { DEFAULT_MODEL, type FeeKind } from "./model.js";
import { DEFAULT_PREDICTIVE, type FastModelConfig, type PredictiveConfig } from "./predictive.js";
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

/** Archivo de `npm run calibrate`: coeficientes de la deriva recalculados con los datos guardados */
export interface Calibration {
  createdAt: string;
  features: string[];
  betas: number[];
  /** correlacion fuera de muestra por horizonte (informativo) */
  outOfSample: Record<string, number>;
  samples: number;
}

/** Lee la calibracion si existe y es coherente (mismas variables); si no, null y se usan los coeficientes por defecto. */
export function loadCalibration(path: string): Calibration | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Calibration;
    if (c.features.join() !== MICRO_FEATURES.join() || c.betas.length !== MICRO_FEATURES.length || c.betas.some((b) => !Number.isFinite(b))) return null;
    return c;
  } catch {
    return null;
  }
}

/** Configuracion efectiva de los motores D y E (variables PM_FAST_*, PM_D_*, PM_E_*, PM_DRIFT_GAIN y la calibracion). */
export function serverFast(venue: Venue = "polymarket"): { predictive: PredictiveConfig; maker: MakerConfig; drift: DriftConfig; calibration: Calibration | null } {
  const f = config.pmFast;
  const v = venueModel(venue);
  const fair: FastModelConfig = {
    model: { ...DEFAULT_MODEL, flowGain: 0, twapSeconds: v.twapSeconds, basisSeconds: v.basisSeconds },
    modelWeight: f.modelWeight,
    modelWeightEnd: f.modelWeightEnd,
    endTauS: 30,
  };
  const common = {
    fair,
    feeRate: v.feeRate,
    feeKind: v.feeKind,
    slippage: config.pmSlippage,
    bankroll: config.pmBankroll,
    kellyFraction: config.pmKellyFraction,
    maxStakePct: config.pmMaxStakePct,
    maxMarketPct: config.pmMaxMarketPct,
    warmupS: config.pmWarmupS,
  };
  const calibration = loadCalibration(f.calibrationPath);
  return {
    predictive: { ...DEFAULT_PREDICTIVE, ...common, minEdge: f.d.minEdge, limitMargin: f.d.limitMargin, exitMargin: f.d.exitMargin, noEntryS: f.d.noEntryS },
    maker: {
      ...DEFAULT_MAKER,
      ...common,
      edge: f.e.edge,
      exitEdge: f.e.exitEdge,
      needDrift: f.e.needDrift,
      dropCancel: f.e.dropCancel,
      stop: f.e.stop,
      minRestMs: f.e.minRestMs,
      noEntryS: f.e.noEntryS,
    },
    drift: { ...DEFAULT_DRIFT, gain: f.driftGain, ...(calibration ? { betas: calibration.betas as MicroVector } : {}) },
    calibration,
  };
}
