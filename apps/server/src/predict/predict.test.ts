import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLevels, levels, mirrorBook, parseRound, parseToken, resultOf, tokenOf, type RawRound } from "./model.js";
import { modelProbUp, takerFee } from "../polymarket/model.js";

/** Ronda real de mainnet (recortada), 27 nov 2026 19:00-19:05 UTC */
const raw = (over: Partial<RawRound> = {}, upDown: { startPrice?: number | null; endPrice?: number | null } = { startPrice: 59913.055 }): RawRound => ({
  slug: "btc-updown-5m-1795806000",
  title: "Bitcoin Up or Down - November 27, 2PM-2:05PM ET",
  startsAt: "2026-11-27T19:00:00.000Z",
  endsAt: "2026-11-27T19:05:00.000Z",
  markets: [
    {
      id: 4837559,
      outcomes: [
        { name: "Up", indexSet: 1, onChainId: "111" },
        { name: "Down", indexSet: 2, onChainId: "222" },
      ],
      feeRateBps: 200,
      decimalPrecision: 2,
      isNegRisk: false,
      isYieldBearing: false,
    },
  ],
  variantDetails: { upDown },
  ...over,
});
const START = Date.parse("2026-11-27T19:00:00.000Z");

test("parseRound normaliza una ronda real", () => {
  assert.deepEqual(parseRound(raw()), {
    slug: "btc-updown-5m-1795806000",
    marketId: 4837559,
    title: "Bitcoin Up or Down - November 27, 2PM-2:05PM ET",
    start: START,
    end: START + 300_000,
    priceToBeat: 59913.055,
    closePrice: null,
    trading: { upTokenId: "111", downTokenId: "222", feeRateBps: 200, decimalPrecision: 2, isNegRisk: false, isYieldBearing: false },
  });
  assert.equal(parseRound(raw({}, {}))?.priceToBeat, null);
  assert.equal(parseRound(raw({}, { startPrice: 100, endPrice: 99 }))?.closePrice, 99);
});

test("parseRound descarta rondas sin market o con el libro en otro outcome", () => {
  assert.equal(parseRound(raw({ markets: [] })), null);
  const flipped = raw();
  flipped.markets![0]!.outcomes = [
    { name: "Down", indexSet: 1 },
    { name: "Up", indexSet: 2 },
  ];
  assert.equal(parseRound(flipped), null);
});

test("resultOf: empate sin lado (50-50)", () => {
  assert.equal(resultOf(100, 101), "up");
  assert.equal(resultOf(100, 99), "down");
  assert.equal(resultOf(100, 100), null);
  assert.equal(resultOf(null, 100), null);
});

test("tokens sinteticos", () => {
  assert.equal(tokenOf(7, "up"), "7:up");
  assert.deepEqual(parseToken("7:down"), { marketId: 7, side: "down" });
  assert.equal(parseToken("123abc"), null);
});

test("mirrorBook: Down es el espejo de Up, con el orden de un libro", () => {
  const up = { bids: [[0.8, 10], [0.79, 5]] as [number, number][], asks: [[0.83, 3], [0.9, 1]] as [number, number][] };
  const down = mirrorBook(up.bids, up.asks);
  assert.deepEqual(down.bids, [[0.17, 3], [0.1, 1]]); // descendente
  assert.deepEqual(down.asks, [[0.2, 10], [0.21, 5]]); // ascendente
});

test("diffLevels: tamanos nuevos y niveles que desaparecen", () => {
  const prev: [number, number][] = [[0.5, 10], [0.49, 4]];
  const next: [number, number][] = [[0.5, 7], [0.48, 2]];
  assert.deepEqual(diffLevels(prev, next).sort((a, b) => b[0] - a[0]), [[0.5, 7], [0.49, 0], [0.48, 2]]);
  assert.deepEqual(diffLevels(prev, prev), []);
  assert.deepEqual(levels([[0.5, 1], ["x", 2], [0.4]]), [[0.5, 1]]);
});

test("comision de Predict: feeRate · min(p, 1-p)", () => {
  assert.equal(takerFee(0.5, 0.02, "min"), 0.01);
  assert.ok(Math.abs(takerFee(0.99, 0.02, "min") - 0.0002) < 1e-12);
  // la de Polymarket no cambia
  assert.equal(takerFee(0.5, 0.05), 0.0125);
});

test("modelo sin TWAP: precio puntual, varianza sigma²·tau", () => {
  const cfg = { twapSeconds: 0, flowGain: 0, flowHorizonS: 30, modelWeight: 1, signalHalfLifeS: 45, cvdWindowS: 20, signalWeights: { stackedImbalance: 1, absorption: 1, exhaustion: 1, cvdDivergence: 1 } };
  // 10 USD por encima con sigma 1 y 100 s: z = 10 / 10 = 1 -> ~0.841
  const p = modelProbUp({ x: 110, k: 100, tau: 100, sigma: 1, tailAvg: null, flow: 0 }, cfg);
  assert.ok(Math.abs(p - 0.8413) < 0.001, `p=${p}`);
  // al cierre no hay NaN: decide el precio actual
  assert.ok(modelProbUp({ x: 110, k: 100, tau: 0, sigma: 1, tailAvg: null, flow: 0 }, cfg) > 0.99);
  assert.ok(modelProbUp({ x: 90, k: 100, tau: 0, sigma: 1, tailAvg: null, flow: 0 }, cfg) < 0.01);
});

import { predictBuyUsd, sharesToWei, slippageForLimit, usdToWei, walletFill, PREDICT_MIN_BUY_USD } from "./liveTrader.js";
import { buildPredictProbeOrder, PREDICT_PROBE_SIGNATURE } from "./latency.js";

test("compras reales: nunca por debajo del minimo de Predict (1 USDT)", () => {
  const c = { scale: 0.2, minUsd: 1, maxUsd: 10 };
  assert.equal(PREDICT_MIN_BUY_USD, 1);
  assert.equal(predictBuyUsd(0, c, 40), 1); // modo minimo
  assert.equal(predictBuyUsd(2, c, 40), 1); // 2 x 0.2 = 0.4 -> sube al minimo
  assert.equal(predictBuyUsd(30, c, 40), 6);
  assert.equal(predictBuyUsd(100, c, 40), 10); // tope por orden
  assert.equal(predictBuyUsd(100, c, 3.5), 3.5); // lo que queda del tope por market
  assert.equal(predictBuyUsd(100, c, 0.99), null); // no llega al minimo: no se envia
  assert.equal(predictBuyUsd(0, { ...c, minUsd: 0.5 }, 40), 1); // un minimo configurado menor no baja del de Predict
});

test("compras reales: importes en wei y deslizamiento del limite de D", () => {
  assert.equal(usdToWei(1), 10n ** 18n);
  assert.equal(usdToWei(2.57), 2570000000000000000n);
  assert.equal(sharesToWei(1.23456), 1234000000000000000n);
  // limite 0.60 con el peor nivel a 0.57: 1 - 0.57/0.60 = 5 % (lo justo para no pasar del limite)
  assert.equal(slippageForLimit(0.6, 0.57), 500); // 0.57 / 0.95 = 0.60: justo el limite
  assert.equal(slippageForLimit(0.5, 0.57), 0);
});

test("compras reales: ejecucion desde el evento de la wallet (comision en tokens o en USDT)", () => {
  const buy = walletFill("buy", { fill: { executedSizeWei: "10000000000000000000", executedValueWei: "5000000000000000000" }, fee: { amountWei: "200000000000000000", type: "SHARES" } });
  assert.deepEqual(buy, { shares: 9.8, usd: 5 });
  const sell = walletFill("sell", { fill: { executedSizeWei: "10000000000000000000", executedValueWei: "6000000000000000000" }, fee: { amountWei: "80000000000000000", type: "COLLATERAL" } });
  assert.deepEqual(sell, { shares: 10, usd: 5.92 });
  assert.equal(walletFill("buy", {}), null);
});

test("sonda de latencia: la orden de prueba nunca puede ejecutarse", () => {
  const now = Date.parse("2026-11-27T21:00:00Z");
  const body = JSON.parse(buildPredictProbeOrder({ tokenId: "1", maker: "0xabc", nowMs: now, salt: 7, feeRateBps: 200 }));
  const o = body.data.order;
  assert.equal(o.signature, PREDICT_PROBE_SIGNATURE); // firma de ceros
  assert.ok(Number(o.expiration) - now / 1000 < 120); // expira antes del minimo de 2 min
  assert.equal(body.data.isPostOnly, true); // post-only a 0,01: no cruzaria el libro
  assert.equal(body.data.pricePerShare, "10000000000000000");
});

import { buyAmountsAtLeast } from "./liveTrader.js";

test("compras reales: el importe firmado nunca queda por debajo de 1 USDT (el SDK redondea hacia abajo)", () => {
  // como el SDK: firma el presupuesto menos un resto de redondeo (1 USDT -> 0,999972)
  const sdk = (v: bigint) => ({ makerAmount: v - 28000000000000n });
  const r = buyAmountsAtLeast(sdk, 1, 1)!;
  assert.equal(r.usd, 1.01);
  assert.ok(r.amounts.makerAmount >= 10n ** 18n);
  // con margen de sobra no se toca
  assert.equal(buyAmountsAtLeast(sdk, 2.5, 1)!.usd, 2.5);
  // si nunca llega (libro vacio: firma 0), no se envia
  assert.equal(buyAmountsAtLeast(() => ({ makerAmount: 0n }), 1, 1), null);
});
