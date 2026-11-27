import { test } from "node:test";
import assert from "node:assert/strict";
import type { AggTrade, PmMarket, PmPoint } from "@updown/protocol";
import { AsOf, PmFeed, SecondCvd, TimedEngine } from "./timedEngine.js";
import { DEFAULT_STRATEGY, SignalEngine } from "./strategy.js";
import { OrderflowEngine } from "../analysis/engine.js";
import { DEFAULT_DETECTOR } from "../analysis/detectors.js";

const T0 = 1_700_000_100_000; // multiplo de 300 s
const market: PmMarket = {
  slug: "m",
  title: "t",
  start: T0,
  end: T0 + 300_000,
  upToken: "u",
  downToken: "d",
  priceToBeat: 60_000,
  closePrice: null,
  changePct: null,
  status: "live",
  result: null,
};
const trade = (id: number, time: number, price = 60_000 + Math.round(Math.sin(id / 9) * 30), qty = 0.1 + (id % 5) * 0.03): AggTrade => ({
  id,
  price,
  quantity: qty,
  time,
  isBuyerMaker: id % 3 === 0,
  symbol: "BTCUSDT",
});

test("AsOf: ultimo valor con time <= T; prune conserva el vigente", () => {
  const a = new AsOf<number>();
  a.push(1000, 1);
  a.push(3000, 3);
  a.push(2000, 2); // desordenado
  assert.equal(a.at(999), undefined);
  assert.equal(a.at(2500), 2);
  assert.equal(a.at(3000), 3);
  a.prune(2500);
  assert.equal(a.at(2600), 2);
  assert.equal(a.at(1500), undefined);
});

test("SecondCvd: mismos puntos que el motor de orderflow para los mismos trades", () => {
  const eng = new OrderflowEngine({ barMs: 60_000, barHistory: 60, tick: 1, retentionMs: 900_000, detector: { ...DEFAULT_DETECTOR, tick: 1, barMs: 60_000 } });
  const sc = new SecondCvd(900_000);
  let id = 0;
  for (let t = T0 - 120_000; t < T0; t += 370) {
    const tr = trade(id++, t);
    eng.ingest(tr);
    sc.add(tr);
  }
  eng.ingest(trade(id++, T0)); // cierra el ultimo segundo en el motor
  sc.closeTo(T0);
  assert.deepEqual(sc.points, eng.cvdPoints);
});

/** Mismos datos llegando en otro orden y con datos "del futuro" antes de decidir: las decisiones deben ser identicas. */
test("motor asOf: decide lo mismo aunque los datos lleguen en otro orden o haya datos posteriores a T", () => {
  const cfg = { ...DEFAULT_STRATEGY, warmupS: 0 };
  const opts = { id: "c" as const, mode: "asOf" as const, delayMs: 150, strategy: cfg, retentionMs: 900_000, decisionsMax: 400 };
  const fa = new PmFeed();
  const fb = new PmFeed();
  const a = new TimedEngine(opts, fa);
  const b = new TimedEngine(opts, fb);
  const trades: AggTrade[] = [];
  let id = 0;
  for (let t = T0 - 300_000; t < T0 + 120_000; t += 450) trades.push(trade(id++, t));
  const quotes = Array.from({ length: 240 }, (_, i) => ({ time: T0 - 1000 + i * 500 + 37, up: 0.3 + (i % 40) / 100 }));

  const feed = (e: TimedEngine, until: number, ahead: number) => {
    for (const t of trades) if (t.time < until + ahead && !(e as unknown as { fed?: Set<number> }).fed?.has(t.id)) {
      ((e as unknown as { fed?: Set<number> }).fed ??= new Set()).add(t.id);
      e.addTrade(t);
    }
  };
  const decisions = { a: [] as unknown[], b: [] as unknown[] };
  for (let T = T0; T < T0 + 100_000; T += 1000) {
    // A: recibe justo lo anterior a T. B: recibe tambien 800 ms "del futuro" y en orden inverso
    feed(a, T, 0);
    feed(b, T, 800);
    for (const q of quotes.filter((q) => q.time <= T)) {
      fa.onQuote("u", q.up - 0.01, q.up + 0.01, q.time);
      fa.onQuote("d", 0.99 - q.up - 0.01, 0.99 - q.up + 0.01, q.time);
    }
    for (const q of quotes.filter((q) => q.time <= T + 800).reverse()) {
      fb.onQuote("u", q.up - 0.01, q.up + 0.01, q.time);
      fb.onQuote("d", 0.99 - q.up - 0.01, 0.99 - q.up + 0.01, q.time);
    }
    fa.onChainlink(T - 400, 60_000 + (T - T0) / 4000);
    fb.onChainlink(T + 600, 99_999); // posterior a T: un motor asOf no debe usarlo
    fb.onChainlink(T - 400, 60_000 + (T - T0) / 4000);
    decisions.a.push(a.step(T, market, [])?.decision ?? null);
    decisions.b.push(b.step(T, market, [])?.decision ?? null);
  }
  assert.ok(decisions.a.every((d) => d !== null));
  assert.deepEqual(decisions.b, decisions.a);
});

test("decision: 'ok' exactamente cuando se emite la senal, y el edge coincide", () => {
  const e = new SignalEngine(market, { ...DEFAULT_STRATEGY, warmupS: 0 });
  const p: PmPoint = { time: T0 + 60_000, chainlink: 60_040, upBid: 0.4, upAsk: 0.41, downBid: 0.58, downAsk: 0.6, binance: 60_040, basis: 0, sigma: 2, flow: 0, pModel: null };
  const r = e.step(p);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0]!.side, "up");
  assert.equal(r.decision.up.buy, "ok");
  assert.equal(r.decision.up.buyEdge, r.signals[0]!.edge);
  assert.equal(r.decision.down.buy, "edge");
  assert.deepEqual(r.decision.signals, r.signals);
  // al segundo siguiente ya tiene Up: no compra mas (holding) y evalua la venta
  const r2 = e.step({ ...p, time: p.time + 1000 });
  assert.equal(r2.decision.up.buy, "holding");
  assert.notEqual(r2.decision.up.sell, "flat");
  assert.equal(r2.decision.up.shares, r.signals[0]!.shares);
});

test("motor live (A): usa lo ultimo recibido aunque su marca sea posterior a T; asOf no", () => {
  const cfg = { ...DEFAULT_STRATEGY, warmupS: 0 };
  const feed = new PmFeed();
  const live = new TimedEngine({ id: "a", mode: "live", delayMs: 0, strategy: cfg, retentionMs: 900_000, decisionsMax: 10 }, feed);
  const asOf = new TimedEngine({ id: "c", mode: "asOf", delayMs: 150, strategy: cfg, retentionMs: 900_000, decisionsMax: 10 }, feed);
  for (let i = 0; i < 400; i++) {
    const t = trade(i, T0 - 200_000 + i * 500);
    live.addTrade(t);
    asOf.addTrade(t);
  }
  const T = T0 + 30_000;
  feed.onQuote("u", 0.4, 0.42, T - 500);
  feed.onQuote("u", 0.6, 0.62, T + 100); // llego "del futuro" respecto a T
  feed.onChainlink(T - 500, 60_000);
  assert.equal(live.step(T, market, [])?.point.upBid, 0.6);
  assert.equal(asOf.step(T, market, [])?.point.upBid, 0.4);
});
