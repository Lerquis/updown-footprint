import { test } from "node:test";
import assert from "node:assert/strict";
import type { PmPoint, PmSignal } from "@updown/protocol";
import { takerFee } from "./model.js";
import { executeWithDelay } from "./replay.js";
import { computePnl, DEFAULT_STRATEGY } from "./strategy.js";

const T0 = 1_700_000_100_000;
const cfg = { feeRate: 0.05, slippage: 0.005 };

const point = (sec: number, upBid: number | null, upAsk: number | null, msOffset = 0): PmPoint => ({
  time: T0 + sec * 1000 + msOffset,
  chainlink: null,
  upBid,
  upAsk,
  downBid: upAsk === null ? null : 1 - upAsk,
  downAsk: upBid === null ? null : 1 - upBid,
  binance: null,
  basis: null,
  sigma: null,
  flow: null,
  pModel: null,
});

const signal = (sec: number, action: "buy" | "sell", price: number, amount: number, shares: number): PmSignal => ({
  id: `s${sec}`,
  slug: "m",
  time: T0 + sec * 1000,
  action,
  side: "up",
  reason: action === "buy" ? "entry" : "exit",
  price,
  fee: takerFee(price, cfg.feeRate),
  shares,
  amount,
  pSide: 0.6,
  edge: 0.05,
  tau: 300 - sec,
});

test("retraso 0: igual que el resultado de papel", () => {
  const buyShares = 20 / (0.5 + takerFee(0.5, 0.05) + 0.005);
  const sellAmount = Math.round(buyShares * (0.7 - takerFee(0.7, 0.05) - 0.005) * 100) / 100;
  const trades = [signal(30, "buy", 0.5, 20, buyShares), signal(100, "sell", 0.7, sellAmount, buyShares)];
  const run = executeWithDelay(trades, [], 0, "down", cfg);
  assert.deepEqual(run.pnl, computePnl(trades, "down"));
  assert.ok(run.fills.every((f) => f.status === "filled" && f.execPrice === f.signalPrice));
});

test("retraso 1 s: compra al ask y vende al bid del segundo siguiente, mismo importe en USDC", () => {
  const points = [point(30, 0.49, 0.5), point(31, 0.55, 0.56), point(100, 0.7, 0.71), point(101, 0.65, 0.66)];
  const trades = [signal(30, "buy", 0.5, 20, 38), signal(100, "sell", 0.7, 25, 38)];
  const run = executeWithDelay(trades, points, 1, "up", cfg);
  const [buy, sell] = run.fills;
  assert.equal(buy!.execPrice, 0.56);
  assert.equal(buy!.execTime, T0 + 31_000);
  assert.equal(buy!.amount, 20);
  const shares = 20 / (0.56 + takerFee(0.56, 0.05) + 0.005);
  assert.ok(Math.abs(buy!.shares - shares) < 1e-3);
  assert.equal(sell!.execPrice, 0.65);
  assert.ok(Math.abs(sell!.amount - shares * (0.65 - takerFee(0.65, 0.05) - 0.005)) < 0.01);
  assert.equal(run.pnl.openUp, 0);
  assert.ok(Math.abs(run.pnl.net! - (sell!.amount - 20)) < 0.01);
});

test("muestras desalineadas (base v1): toma la del segundo siguiente aunque llegue unos ms antes", () => {
  const points = [point(30, 0.49, 0.5, 896), point(31, 0.6, 0.61, 880), point(32, 0.7, 0.71, 900)];
  const trades = [signal(30, "buy", 0.5, 10, 19)];
  trades[0]!.time = T0 + 30_896;
  const run = executeWithDelay(trades, points, 1, "up", cfg);
  assert.equal(run.fills[0]!.execPrice, 0.61);
});

test("sin precio o sin muestra: la compra no se ejecuta y la venta posterior queda sin posicion", () => {
  const points = [point(30, 0.49, 0.5), point(31, 0.55, null)];
  const trades = [signal(30, "buy", 0.5, 20, 38), signal(100, "sell", 0.7, 25, 38)];
  const run = executeWithDelay(trades, points, 1, "up", cfg);
  assert.deepEqual(
    run.fills.map((f) => f.status),
    ["missed", "noPosition"],
  );
  assert.equal(run.pnl.invested, 0);
  assert.equal(run.pnl.net, 0);
});

test("venta sin muestra posterior (market cerrado): se mantiene hasta el pago", () => {
  const points = [point(30, 0.49, 0.5), point(31, 0.5, 0.51)];
  const trades = [signal(30, "buy", 0.5, 20, 38), signal(299, "sell", 0.9, 30, 38)];
  const run = executeWithDelay(trades, points, 1, "up", DEFAULT_STRATEGY);
  assert.equal(run.fills[1]!.status, "missed");
  assert.ok(run.pnl.openUp > 0);
  assert.ok(Math.abs(run.pnl.net! - (run.pnl.openUp - 20)) < 0.01);
});
