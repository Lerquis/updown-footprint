import { test } from "node:test";
import assert from "node:assert/strict";
import type { PmPnl, PmRecord, PmSide, PmSignal } from "@updown/protocol";
import { compareEngine, compareMarkets, compareTotals, firstEntry } from "./compare.js";
import { splitSource } from "../source.js";
import { sourcePath } from "@updown/protocol";

const T0 = 1_700_000_100_000;

const sig = (time: number, side: PmSide, price: number, action: "buy" | "sell" = "buy", reason: PmSignal["reason"] = "entry"): PmSignal => ({
  id: `${time}-${side}`,
  slug: "m",
  time,
  action,
  side,
  reason,
  price,
  fee: 0,
  shares: 10,
  amount: price * 10,
  pSide: 0.6,
  edge: 0.05,
  tau: 200,
});

const pnl = (net: number | null, invested = 5): PmPnl => ({ invested, sold: 0, openUp: 0, openDown: 0, net, roi: null });

const record = (slug: string, start: number, trades: PmSignal[], net: number | null, d: PmSignal[] = []): PmRecord => ({
  market: { slug, title: "", start, end: start + 300_000, upToken: "u", downToken: "d", priceToBeat: 1, closePrice: 2, changePct: 0, status: "closed", result: "up" },
  points: [],
  bars: [],
  cvd: [],
  signals: [],
  trades,
  pnl: pnl(net),
  engines: { d: { points: [], trades: d, pnl: pnl(d.length ? 1 : null, d.length ? 5 : 0) } },
  complete: true,
});

test("firstEntry: la primera compra de entrada, no salidas ni flips", () => {
  const t = [sig(T0 + 5000, "up", 0.5, "sell", "exit"), sig(T0 + 3000, "down", 0.4, "buy", "flip"), sig(T0 + 4000, "up", 0.55), sig(T0 + 6000, "up", 0.6)];
  assert.equal(firstEntry(t)?.time, T0 + 4000);
  assert.equal(firstEntry([]), null);
});

test("compareEngine: mismo lado => adelanto de futures y diferencia de precio", () => {
  const s = record("m", T0, [sig(T0 + 10_400, "up", 0.56)], 2);
  const f = record("m", T0, [sig(T0 + 10_000, "up", 0.53)], 3);
  const c = compareEngine(s, f, "a");
  assert.equal(c.leadMs, 400); // futures 400 ms antes
  assert.equal(c.priceDiff, 0.03); // y 3 centavos mas barato
  assert.deepEqual([c.spotSide, c.futuresSide], ["up", "up"]);
  assert.equal(c.spot.net, 2);
  assert.equal(c.futures.net, 3);
});

test("compareEngine: lados distintos o sin entrada => sin adelanto", () => {
  const s = record("m", T0, [sig(T0 + 1000, "up", 0.5)], 1);
  const f = record("m", T0, [sig(T0 + 900, "down", 0.5)], -1);
  assert.equal(compareEngine(s, f, "a").leadMs, null);
  const none = record("m", T0, [], null);
  const c = compareEngine(s, none, "a");
  assert.equal(c.leadMs, null);
  assert.equal(c.futuresSide, null);
  // motores secundarios: se leen de `engines`; sin run, resumen vacio
  const e = compareEngine(s, none, "e");
  assert.deepEqual(e.spot, { trades: 0, invested: 0, net: null });
});

test("compareMarkets empareja por slug y compareTotals suma por motor", () => {
  const spot = [
    record("m1", T0, [sig(T0 + 1000, "up", 0.6)], 1, [sig(T0 + 2000, "up", 0.6)]),
    record("m2", T0 + 300_000, [sig(T0 + 301_000, "down", 0.4)], -2),
    record("m3", T0 + 600_000, [sig(T0 + 601_000, "up", 0.5)], 1), // solo spot: no entra
  ];
  const futures = [
    record("m1", T0, [sig(T0 + 800, "up", 0.58)], 2, [sig(T0 + 2100, "up", 0.61)]),
    record("m2", T0 + 300_000, [], null),
  ];
  const rows = compareMarkets(spot, futures);
  assert.deepEqual(rows.map((r) => r.slug), ["m2", "m1"]);
  const t = compareTotals(rows);
  assert.equal(t.a.markets, 2);
  assert.equal(t.a.spotNet, -1);
  assert.equal(t.a.futuresNet, 2);
  assert.equal(t.a.sameSide, 1);
  assert.equal(t.a.futuresFirst, 1);
  assert.equal(t.a.avgLeadMs, 200);
  assert.equal(t.a.onlySpot, 1);
  assert.equal(t.d.sameSide, 1);
  assert.equal(t.d.spotFirst, 1);
  assert.equal(t.d.medianLeadMs, -100);
  assert.equal(t.d.avgPriceDiff, -0.01);
});

test("rutas por fuente: sourcePath y splitSource son inversas", () => {
  assert.equal(sourcePath("spot", "/ws/orderflow"), "/ws/orderflow");
  assert.equal(sourcePath("futures", "/ws/orderflow"), "/ws/futures/orderflow");
  assert.equal(sourcePath("futures", "/api/markets/x"), "/api/futures/markets/x");
  for (const p of ["/ws/orderflow", "/api/markets/abc", "/api/trading/arm"]) {
    assert.deepEqual(splitSource(sourcePath("futures", p)), { source: "futures", path: p });
    assert.deepEqual(splitSource(sourcePath("spot", p)), { source: "spot", path: p });
  }
  assert.deepEqual(splitSource("/health"), { source: "spot", path: "/health" });
});
