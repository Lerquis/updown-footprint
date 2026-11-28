import { test } from "node:test";
import assert from "node:assert/strict";
import type { FootprintBar, PmMarket, PmPoint, PmRecord } from "@updown/protocol";
import type { PolymarketApi } from "./api.js";
import { PolymarketTracker, buildRecord, slotStart, type BookLike, type FlowSource } from "./tracker.js";

const M = 300_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % M); // inicio alineado

const bar = (start: number) => ({ start }) as FootprintBar;
const flow: FlowSource = {
  bars: () => [bar(T0 - 60_000), bar(T0), bar(T0 + 60_000), bar(T0 + M)],
  cvd: () => [
    { time: T0, cvd: 0, price: 1, vol: 0 }, // limite inferior: pertenece al market previo
    { time: T0 + 1000, cvd: 1, price: 1, vol: 1 },
    { time: T0 + M, cvd: 2, price: 1, vol: 1 }, // limite superior: incluido
    { time: T0 + M + 1000, cvd: 3, price: 1, vol: 1 },
  ],
  signals: () => [],
};

const market = (start: number): PmMarket => ({
  slug: `btc-updown-5m-${start / 1000}`,
  title: "",
  start,
  end: start + M,
  upToken: "u",
  downToken: "d",
  priceToBeat: null,
  closePrice: null,
  changePct: null,
  status: "live",
  result: null,
});

test("slotStart alinea a la ventana", () => {
  assert.equal(slotStart(T0 + 123_456, M), T0);
  assert.equal(slotStart(T0 + M, M), T0 + M);
});

test("buildRecord recorta barras y CVD a la ventana", () => {
  const rec = buildRecord(market(T0), { a: { points: [] as PmPoint[], trades: [] }, c: { points: [], trades: [] } }, flow);
  assert.deepEqual(rec.bars.map((b) => b.start), [T0, T0 + 60_000]);
  assert.deepEqual(rec.cvd.map((p) => p.cvd), [1, 2]);
});

test("el tracker rota, archiva y resuelve el market", async () => {
  const api: PolymarketApi = {
    fetchMarket: async (slug) => ({ title: slug, upToken: "u", downToken: "d" }),
    fetchPriceToBeat: async () => 100,
    fetchResult: async (_slug, start) => (start === T0 ? { result: "down", openPrice: 100, closePrice: 99, changePct: -1 } : null),
  };
  let books = 0;
  const makeBook = (): BookLike => {
    books++;
    return { state: "connected", start() {}, stop() {}, on() {} };
  };
  const tr = new PolymarketTracker(api, flow, makeBook, {
    marketMs: M, slugPrefix: "btc-updown-5m", historyMax: 2, graceMs: 5000, retryMs: 0, resolveTries: 10, pointsMax: 500,
  });
  const records: PmRecord[] = [];
  tr.on("record", (r) => records.push(r));
  const settle = () => new Promise((r) => setImmediate(r));

  // el tracker ya no muestrea: recibe los pasos de los motores (aqui, dos del A y uno del C)
  const pt = (t: number): PmPoint => ({ time: t, chainlink: 100.5, upBid: 0.5, upAsk: 0.51, downBid: 0.49, downAsk: 0.5, binance: 1, basis: 0, sigma: 1, flow: 0, pModel: 0.5 });
  tr.tick(T0 + 1000);
  await settle();
  tr.tick(T0 + 2000);
  const slug0 = tr.current!.slug;
  tr.addStep("a", slug0, pt(T0 + 1000), []);
  tr.addStep("a", slug0, pt(T0 + 2000), []);
  tr.addStep("c", slug0, pt(T0 + 2000), []);
  assert.equal(tr.current?.start, T0);
  assert.equal(tr.current?.upToken, "u");
  assert.equal(tr.current?.priceToBeat, 100);
  assert.equal(tr.next?.start, T0 + M);
  assert.equal(tr.points.length, 2);
  assert.equal(tr.points.at(-1)?.chainlink, 100.5);
  assert.equal(tr.live("c").points.length, 1);
  assert.equal(books, 1);

  tr.tick(T0 + M + 1000); // rota
  assert.equal(tr.current?.start, T0 + M);
  assert.equal(tr.points.length, 0); // market nuevo, sin pasos aun
  assert.equal(records.length, 0); // aun en periodo de gracia

  tr.tick(T0 + M + 6000);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.market.status, "resolving");
  assert.equal(records[0]!.points.length, 2);
  assert.equal(records[0]!.engines?.c?.points.length, 1);
  await settle();
  tr.tick(T0 + M + 7000);
  await settle();
  const closed = tr.history[0]!.market;
  assert.equal(closed.status, "closed");
  assert.equal(closed.result, "down");
  assert.equal(closed.closePrice, 99);
  assert.equal(closed.changePct, -1);
  assert.equal(records.length, 2); // upsert con el resultado
});

test("gammaOutcome: ganador solo con el market cerrado y precios finales 1/0", async () => {
  const { gammaOutcome } = await import("./api.js");
  const m = (closed: boolean, prices: string) => ({ closed, outcomes: '["Up", "Down"]', outcomePrices: prices });
  assert.equal(gammaOutcome(m(true, '["0", "1"]')), "down");
  assert.equal(gammaOutcome(m(true, '["1", "0"]')), "up");
  assert.equal(gammaOutcome(m(false, '["1", "0"]')), null);
  assert.equal(gammaOutcome(m(true, '["0.52", "0.48"]')), null);
  assert.equal(gammaOutcome(undefined), null);
});
