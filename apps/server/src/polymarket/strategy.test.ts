import { test } from "node:test";
import assert from "node:assert/strict";
import type { CvdPoint, OrderflowSignal, PmMarket, PmPoint, PmRecord } from "@updown/protocol";
import { blend, estimateSigma, flowScore, modelProbUp, normCdf, takerFee } from "./model.js";
import { SignalEngine, computePnl, replayMarket, DEFAULT_STRATEGY, type StrategyConfig } from "./strategy.js";
import { isComplete, buildRecord, type EngineTracks } from "./tracker.js";
/** Solo motor A (C vacio) */
const onlyA = (points: PmPoint[]): EngineTracks => ({ a: { points, trades: [] }, c: { points: [], trades: [] } });
import { MarketStore, TRADES_LEAD_MS } from "./store.js";
import { rebuildOrderflow } from "./rebuild.js";
import { OrderflowEngine } from "../analysis/engine.js";
import { DEFAULT_DETECTOR } from "../analysis/detectors.js";

const T0 = 1_700_000_100_000;
const market = (over: Partial<PmMarket> = {}): PmMarket => ({
  slug: `btc-updown-5m-${T0 / 1000}`,
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
  ...over,
});
const point = (sec: number, over: Partial<PmPoint> = {}): PmPoint => ({
  time: T0 + sec * 1000,
  chainlink: 60_000,
  upBid: 0.5,
  upAsk: 0.52,
  downBid: 0.48,
  downAsk: 0.5,
  binance: 60_000,
  basis: 0,
  sigma: 3,
  flow: 0,
  pModel: null,
  ...over,
});

test("normCdf valores conocidos", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-4);
});

test("takerFee: 0.05 * p * (1-p), maximo en 0.5 (1.25 por 100 tokens)", () => {
  assert.ok(Math.abs(takerFee(0.5, 0.05) * 100 - 1.25) < 1e-9);
  assert.ok(Math.abs(takerFee(0.3, 0.05) * 100 - 1.05) < 1e-9);
});

test("modelProbUp: en el price to beat ~0.5; arriba mas de 0.5; mas cerca del cierre mas seguro", () => {
  const base = { k: 60_000, sigma: 3, tailAvg: null, flow: 0 };
  assert.ok(Math.abs(modelProbUp({ ...base, x: 60_000, tau: 200 }) - 0.5) < 0.01);
  const far = modelProbUp({ ...base, x: 60_020, tau: 250 });
  const near = modelProbUp({ ...base, x: 60_020, tau: 20, tailAvg: 60_015 });
  assert.ok(far > 0.5 && near > far);
  assert.ok(modelProbUp({ ...base, x: 59_980, tau: 100 }) < 0.5);
});

test("modelProbUp: con el TWAP casi hecho pesa lo ya promediado", () => {
  const p = modelProbUp({ x: 59_990, k: 60_000, tau: 5, sigma: 3, tailAvg: 60_050, flow: 0 });
  assert.ok(p > 0.99);
});

test("modelProbUp: el flujo desplaza la probabilidad en su direccion", () => {
  const base = { x: 60_000, k: 60_000, tau: 120, sigma: 3, tailAvg: null };
  assert.ok(modelProbUp({ ...base, flow: 1 }) > 0.5);
  assert.ok(modelProbUp({ ...base, flow: -1 }) < 0.5);
});

test("blend: con modelWeight 1 es el modelo; sin mercado tambien", () => {
  assert.ok(Math.abs(blend(0.8, 0.5, 1) - 0.8) < 1e-9);
  assert.equal(blend(0.8, null, 0.3), 0.8);
  const b = blend(0.9, 0.5, 0.6);
  assert.ok(b > 0.5 && b < 0.9);
});

test("estimateSigma: serie plana => suelo; serie nerviosa => mayor", () => {
  const flat: CvdPoint[] = Array.from({ length: 200 }, (_, i) => ({ time: i * 1000, cvd: 0, price: 60_000, vol: 1 }));
  const wild: CvdPoint[] = flat.map((p, i) => ({ ...p, price: 60_000 + (i % 7) * 10 }));
  assert.ok(estimateSigma(flat)! < estimateSigma(wild)!);
  assert.equal(estimateSigma(flat.slice(0, 10)), null);
});

test("flowScore: senal alcista reciente y CVD comprador => positivo; decae con el tiempo", () => {
  const sig: OrderflowSignal = { id: "a", type: "stackedImbalance", bias: "bullish", barStart: 0, time: 100_000, priceLo: 1, priceHi: 2, strength: 3 };
  const cvd: CvdPoint[] = Array.from({ length: 30 }, (_, i) => ({ time: 100_000 + i * 1000, cvd: i * 2, price: 60_000, vol: 2 }));
  const now = flowScore(130_000, [sig], cvd);
  const later = flowScore(130_000, [{ ...sig, time: 0 }], cvd);
  assert.ok(now > later && later > 0);
  assert.equal(flowScore(130_000, [], []), 0);
});

// ── motor ──
const cfg: StrategyConfig = { ...DEFAULT_STRATEGY, bankroll: 1000 };
const cheapUp = { upBid: 0.55, upAsk: 0.57, downBid: 0.43, downAsk: 0.45 };

test("motor: sin ventaja (mercado = modelo) no senala", () => {
  const e = new SignalEngine(market(), cfg);
  for (let s = 0; s < 280; s++) assert.deepEqual(e.step(point(s)).signals, []);
});

test("motor: compra Up cuando el precio esta bien por encima y el token esta barato", () => {
  const e = new SignalEngine(market(), cfg);
  let buy;
  for (let s = 0; s < 200 && !buy; s++) buy = e.step(point(s, { binance: s < 60 ? 60_000 : 60_040, ...cheapUp })).signals[0];
  assert.ok(buy, "debe haber senal");
  assert.equal(buy.action, "buy");
  assert.equal(buy.side, "up");
  assert.equal(buy.reason, "entry");
  assert.ok(buy.edge >= cfg.minEdge);
  assert.ok(buy.amount <= cfg.maxStakePct * cfg.bankroll + 1e-6);
});

test("motor: no abre en calentamiento ni en los segundos finales", () => {
  const rich = { binance: 60_100, upBid: 0.5, upAsk: 0.52, downBid: 0.48, downAsk: 0.5 };
  assert.deepEqual(new SignalEngine(market(), cfg).step(point(5, rich)).signals, []);
  assert.deepEqual(new SignalEngine(market(), cfg).step(point(295, rich)).signals, []);
});

test("motor: tras comprar Up, si el precio se da vuelta vende y compra Down (flip)", () => {
  const e = new SignalEngine(market(), cfg);
  let entered = false;
  for (let s = 30; s < 100 && !entered; s++) entered = e.step(point(s, { binance: 60_040, ...cheapUp })).signals.length > 0;
  assert.ok(entered);
  const sigs = e.step(point(150, { binance: 59_950, upBid: 0.6, upAsk: 0.62, downBid: 0.38, downAsk: 0.4 })).signals;
  assert.deepEqual(sigs.map((s) => `${s.action}:${s.side}:${s.reason}`), ["sell:up:exit", "buy:down:flip"]);
});

test("motor: sin price to beat o sin Binance no hay probabilidad", () => {
  assert.equal(new SignalEngine(market({ priceToBeat: null }), cfg).step(point(50)).pUp, null);
  assert.equal(new SignalEngine(market(), cfg).step(point(50, { binance: null })).pUp, null);
});

test("computePnl: compra Up gana / pierde; venta anticipada", () => {
  const buy = { id: "1", slug: "s", time: 1, action: "buy", side: "up", reason: "entry", price: 0.5, fee: 0.0125, shares: 100, amount: 52, pSide: 0.6, edge: 0.05, tau: 100 } as const;
  assert.equal(computePnl([buy], "up").net, 48);
  assert.equal(computePnl([buy], "down").net, -52);
  assert.equal(computePnl([buy], null).net, null);
  const sell = { ...buy, id: "2", action: "sell", reason: "exit", amount: 70 } as const;
  assert.equal(computePnl([buy, sell], "down").net, 18);
});

test("replayMarket reproduce las senales con los puntos guardados", () => {
  const pts = Array.from({ length: 250 }, (_, s) => point(s, { binance: s < 60 ? 60_000 : 60_040, ...cheapUp }));
  const r = replayMarket(market({ result: "up" }), pts, cfg);
  assert.ok(r.trades.length >= 1);
  assert.ok(r.pnl.net! > 0);
});

// ── completitud y base de datos ──
const full = (n: number, from = 0) => Array.from({ length: n }, (_, i) => point(from + i));

test("isComplete: 300 s seguidos si; huecos, inicio tardio o falta de datos no", () => {
  const m = market();
  assert.equal(isComplete(m, full(299)), true);
  assert.equal(isComplete(m, full(250, 50)), false);
  assert.equal(isComplete(m, [...full(100), ...full(150, 150)]), false);
  assert.equal(isComplete(m, full(299).map((p, i) => (i > 150 ? { ...p, chainlink: null } : p))), false);
  assert.equal(isComplete(m, []), false);
});

test("MarketStore: solo guarda markets resueltos y completos; recent devuelve en orden", () => {
  const store = new MarketStore(":memory:");
  const flow = { bars: () => [], cvd: () => [], signals: () => [] };
  const mk = (i: number, pts = full(299)) =>
    buildRecord(
      market({ start: T0 + i * 300_000, end: T0 + (i + 1) * 300_000, slug: `m${i}` }),
      onlyA(pts.map((p) => ({ ...p, time: p.time + i * 300_000 }))),
      flow,
    );
  const resolved = (r: PmRecord): PmRecord => ({ ...r, market: { ...r.market, status: "closed", result: "up" } });
  assert.equal(store.save(mk(0)), false);
  assert.equal(store.save(resolved(mk(1, full(100)))), false);
  assert.equal(store.save(resolved(mk(2))), true);
  assert.equal(store.save(resolved(mk(3))), true);
  assert.equal(store.count(), 2);
  assert.deepEqual(store.recent(5).map((r) => r.market.slug), ["m2", "m3"]);
  store.close();
});

// ── aggTrades, heatmap y reconstruccion ──
const trade = (id: number, time: number, price = 100, quantity = 1, isBuyerMaker = false) => ({ id, symbol: "BTCUSDT", price, quantity, time, isBuyerMaker });
const engCfg = { barMs: 60_000, barHistory: 100, tick: 1, retentionMs: 15 * 60_000, detector: { ...DEFAULT_DETECTOR, tick: 1, barMs: 60_000 } };

test("MarketStore: aggTrades y columnas del heatmap se guardan y se leen (idempotente)", () => {
  const store = new MarketStore(":memory:", "BTCUSDT");
  const ts = [trade(1, 1000, 100.5, 0.25, true), trade(2, 2000, 101, 2, false), trade(3, 3000)];
  ts.forEach((t) => store.addTrade(t));
  ts.forEach((t) => store.addTrade(t)); // duplicados (relleno + vivo) se ignoran
  store.addDepth({ time: 1000, mid: 100, lo: 90, q: [0, 1.5, 2.25, 0] }, 1);
  assert.deepEqual(store.tradesBetween(0, 2500), ts.slice(0, 2));
  const d = store.depthBetween(0, 5000);
  assert.equal(d.step, 1);
  assert.deepEqual(d.columns, [{ time: 1000, mid: 100, lo: 90, q: [0, 1.5, 2.25, 0] }]);
  assert.deepEqual(store.counts(), { markets: 0, trades: 3, depth: 1 });
  store.close();
});

test("MarketStore.tradeCoverage: detecta ids perdidos y bordes sin cubrir", () => {
  const store = new MarketStore(":memory:");
  for (let i = 0; i < 100; i++) store.addTrade(trade(i, 1000 + i * 100));
  assert.equal(store.tradeCoverage(1000, 10_800).ok, true);
  assert.equal(store.tradeCoverage(-10_000, 10_800).ok, false); // empieza tarde
  assert.equal(store.tradeCoverage(1000, 60_000).ok, false); // termina pronto
  store.addTrade(trade(150, 11_000)); // salto de ids: faltan 100..149
  assert.equal(store.tradeCoverage(1000, 11_000).ok, false);
  store.close();
});

test("MarketStore.save: guarda version, parametros y si los aggTrades cubren la ventana", () => {
  const store = new MarketStore(":memory:");
  const flow = { bars: () => [], cvd: () => [], signals: () => [] };
  const m = market({ slug: "a", start: T0, end: T0 + 300_000, status: "closed", result: "up" });
  const rec = buildRecord(m, onlyA(full(299)), flow);
  // sin aggTrades: se guarda, pero marcado como no reconstruible
  assert.equal(store.save(rec, { version: 7, params: { x: 1 } }), true);
  assert.deepEqual(store.meta("a"), { version: 7, params: { x: 1 }, tradesOk: false });
  // con aggTrades continuos desde antes del margen hasta el final: reconstruible
  let id = 0;
  for (let t = T0 - TRADES_LEAD_MS; t <= T0 + 300_000; t += 500) store.addTrade(trade(id++, t));
  assert.equal(store.save(rec, { version: 7, params: { x: 1 } }), true);
  assert.equal(store.meta("a")?.tradesOk, true);
  assert.equal(store.meta("nope"), null);
  store.close();
});

test("rebuildOrderflow: rehace las mismas barras, CVD y senales que el motor en vivo", () => {
  const store = new MarketStore(":memory:");
  const start = 1_700_000_040_000; // multiplo de 60 s
  const end = start + 300_000;
  const live = new OrderflowEngine(engCfg);
  let id = 0;
  for (let t = start - TRADES_LEAD_MS; t < end + 60_000; t += 700) {
    const price = 100 + Math.round(Math.sin(t / 20_000) * 5);
    const tr = trade(id++, t, price, 0.1 + ((t / 700) % 7) * 0.05, (t / 700) % 3 === 0);
    live.ingest(tr);
    store.addTrade(tr);
  }
  const r = rebuildOrderflow(store, start, end, engCfg);
  assert.deepEqual(r.bars, live.bars.filter((b) => b.start >= start && b.start < end));
  assert.deepEqual(r.signals, live.signals.filter((s) => s.barStart >= start && s.barStart < end));
  assert.equal(r.bars.length, 5);
  assert.ok(r.cvd.length >= 299);
  store.close();
});

test("MarketStore.list: filas resumen sin leer el JSON, con filtros, orden y limite", () => {
  const store = new MarketStore(":memory:");
  const flow = { bars: () => [], cvd: () => [], signals: () => [] };
  for (let i = 0; i < 4; i++) {
    const m = market({ slug: `r${i}`, start: T0 + i * 300_000, end: T0 + (i + 1) * 300_000, status: "closed", result: i % 2 ? "down" : "up", priceToBeat: 100, closePrice: 101, changePct: 1 });
    store.save(buildRecord(m, onlyA(full(299).map((p) => ({ ...p, time: p.time + i * 300_000 }))), flow));
  }
  const all = store.list();
  assert.deepEqual(all.map((r) => r.slug), ["r3", "r2", "r1", "r0"]); // mas recientes primero
  assert.equal(all[0]!.end - all[0]!.start, 300_000);
  assert.equal(all[0]!.changePct, 1);
  assert.equal(all[0]!.result, "down");
  assert.equal(all[0]!.tradesOk, false);
  assert.deepEqual(store.list({ order: "asc", limit: 2 }).map((r) => r.slug), ["r0", "r1"]);
  assert.deepEqual(store.list({ from: T0 + 300_000, to: T0 + 3 * 300_000 }).map((r) => r.slug), ["r2", "r1"]);
  store.close();
});
