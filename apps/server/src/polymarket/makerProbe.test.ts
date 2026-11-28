import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { MakerProbeSample, PmMarket, PmSignal } from "@updown/protocol";
import { MakerProbe, makerFill, makerPrice, makerSize, orderEvent, parseCancel, parsePost, type ProbeTrader } from "./makerProbe.js";
import type { ClobCall } from "./liveTrader.js";

test("precio y tamano maker", () => {
  assert.equal(makerPrice("buy", 0.45, 0.47, 0.01), 0.46); // primera de la fila en un nivel nuevo
  assert.equal(makerPrice("buy", 0.45, 0.46, 0.01), 0.45); // spread de 1 tick: se une al mejor bid
  assert.equal(makerPrice("sell", 0.45, 0.47, 0.01), 0.46);
  assert.equal(makerPrice("sell", 0.45, 0.46, 0.01), 0.46);
  assert.equal(makerPrice("buy", null, 0.46, 0.01), null);
  assert.equal(makerSize(0.5, 1, 5), 5); // 1 USDC son 2 tokens: se sube al minimo de 5
  assert.equal(makerSize(0.1, 1, 5), 10); // 1 USDC = 10 tokens
  assert.equal(makerSize(0.15, 1, 5), 6.67); // redondeo hacia arriba: al menos 1 USDC
});

test("eventos y respuestas del CLOB", () => {
  assert.deepEqual(orderEvent({ event_type: "order", id: "0xa", type: "UPDATE", timestamp: "1800000000123", size_matched: "2.5" }), { id: "0xa", type: "UPDATE", at: 1800000000123, msPrecision: true, matched: 2.5 });
  assert.equal(orderEvent({ event_type: "order", id: "0xa", type: "PLACEMENT", timestamp: "1800000000" })!.msPrecision, false);
  assert.equal(orderEvent({ event_type: "trade", id: "0xa" }), null);
  assert.deepEqual(makerFill({ event_type: "trade", id: "t1", maker_orders: [{ order_id: "0xa", matched_amount: "3" }, { order_id: "0xb", matched_amount: "9" }] }, "0xa"), { tradeId: "t1", shares: 3 });
  assert.equal(makerFill({ event_type: "trade", id: "t1", taker_order_id: "0xa", maker_orders: [] }, "0xa"), null);
  assert.deepEqual(parsePost('{"success":true,"orderID":"0xa","status":"live"}'), { orderId: "0xa", status: "live", error: null });
  assert.equal(parsePost('{"success":false,"errorMsg":"invalid post-only order: order crosses book"}').error, "invalid post-only order: order crosses book");
  assert.deepEqual(parseCancel('{"canceled":["0xa"],"not_canceled":{}}', "0xa"), { ok: true, error: null });
  assert.deepEqual(parseCancel('{"canceled":[],"not_canceled":{"0xa":"order not found"}}', "0xa"), { ok: false, error: "order not found" });
});

const T = 1_800_000_000_000;
const market: PmMarket = { slug: "m", title: "", start: T - 100_000, end: T + 200_000, upToken: "u", downToken: "c", status: "live", priceToBeat: 1, closePrice: null, changePct: null, result: null };
const sig = (over: Partial<PmSignal> = {}): PmSignal => ({ id: `s${Math.random()}`, slug: "m", time: T, action: "buy", side: "up", reason: "entry", price: 0.47, fee: 0, shares: 10, amount: 5, pSide: 0.6, edge: 0.1, tau: 100, ...over });

/** Trader falso: responde al instante y emite los eventos del canal de usuario; `fillOn` ejecuta la orden n-esima */
class FakeTrader extends EventEmitter implements ProbeTrader {
  enabled = true;
  disabledReason = null;
  posted: { token: string; side: string; price: number; size: number }[] = [];
  cancels = 0;
  fill: number | null = null;
  constructor(private readonly clock: { t: number }) {
    super();
  }
  async postLimitOrder(token: string, side: "buy" | "sell", price: number, size: number): Promise<ClobCall & { signMs: number }> {
    const n = this.posted.push({ token, side, price, size });
    const id = `0x${n}`;
    const sentAt = this.clock.t;
    this.clock.t += 30;
    this.emit("user", { event_type: "order", id, type: "PLACEMENT", timestamp: String(sentAt + 25) });
    if (this.fill !== null)
      setTimeout(() => {
        this.clock.t = sentAt + 400;
        this.emit("user", { event_type: "trade", id: `t${n}`, status: "MATCHED", maker_orders: [{ order_id: id, matched_amount: String(this.fill ?? size) }] });
        this.emit("user", { event_type: "trade", id: `t${n}`, status: "CONFIRMED", maker_orders: [{ order_id: id, matched_amount: String(this.fill ?? size) }] });
      }, 5);
    return { status: 200, text: `{"success":true,"orderID":"${id}","status":"live"}`, ms: 30, sentAt, respondedAt: this.clock.t, signMs: 3 };
  }
  async cancelOrder(id: string): Promise<ClobCall> {
    this.cancels++;
    const sentAt = this.clock.t;
    this.clock.t += 40;
    this.emit("user", { event_type: "order", id, type: "CANCELLATION", timestamp: String(sentAt + 35) });
    return { status: 200, text: `{"canceled":["${id}"],"not_canceled":{}}`, ms: 40, sentAt, respondedAt: this.clock.t };
  }
}

function setup(max = 10) {
  const clock = { t: T };
  const trader = new FakeTrader(clock);
  const probe = new MakerProbe(
    { max, restMs: 60, minUsd: 1, minShares: 5, maxMarketUsd: 40, tick: 0.01, settleMs: 30 },
    { trader, quote: (t) => (t === "u" ? { bid: 0.45, ask: 0.47 } : { bid: 0.53, ask: 0.55 }), levelSize: () => 0, now: () => clock.t },
  );
  probe.onMarket(market);
  return { probe, trader };
}
const next = (p: MakerProbe) => new Promise<MakerProbeSample>((r) => p.once("sample", r));

test("check maker: sigue solo al motor elegido, coloca a bid + 1 tick y cancela si no se llena", async () => {
  const { probe, trader } = setup();
  probe.setEnabled(true, "c");
  probe.onSignals("a", [sig()], market); // otro motor: nada
  assert.equal(trader.posted.length, 0);
  const got = next(probe);
  probe.onSignals("c", [sig()], market);
  const s = await got;
  assert.deepEqual(trader.posted, [{ token: "u", side: "buy", price: 0.46, size: 5 }]);
  assert.equal(s.status, "unfilled");
  assert.equal(s.engine, "c");
  assert.equal(s.userAckMs, 30);
  assert.equal(s.exchangePlaceMs, 25);
  assert.equal(s.cancelMs, 40);
  assert.equal(trader.cancels, 1);
  assert.equal(probe.state().position.up, 0);
});

test("check maker: si se llena no cancela, guarda los tokens y la venta del motor los ofrece en el ask", async () => {
  const { probe, trader } = setup();
  probe.setEnabled(true, "c");
  trader.fill = 5;
  let got = next(probe);
  probe.onSignals("c", [sig()], market);
  let s = await got;
  assert.equal(s.status, "filled");
  assert.equal(s.filledShares, 5); // el trade repetido (CONFIRMED) no cuenta dos veces
  assert.equal(s.firstFillMs, 400);
  assert.equal(trader.cancels, 0);
  assert.equal(probe.state().position.up, 5);
  assert.ok(Math.abs(probe.state().spentUsd - 2.3) < 1e-9);
  trader.fill = null;
  got = next(probe);
  probe.onSignals("c", [sig({ action: "sell", reason: "exit", price: 0.45 })], market);
  s = await got;
  assert.deepEqual(trader.posted[1], { token: "u", side: "sell", price: 0.46, size: 5 });
  assert.equal(s.status, "unfilled");
});

test("check maker: omite ventas sin tokens y se apaga al llegar al tope", async () => {
  const { probe, trader } = setup(1);
  probe.setEnabled(true, "c");
  let got = next(probe);
  probe.onSignals("c", [sig({ action: "sell", reason: "exit" })], market);
  assert.match((await got).error ?? "", /sin tokens/);
  got = next(probe);
  probe.onSignals("c", [sig()], market);
  await got;
  assert.equal(trader.posted.length, 1);
  assert.equal(probe.state().enabled, false); // tope de 1 orden
  probe.onSignals("c", [sig()], market);
  assert.equal(trader.posted.length, 1);
});

test("check maker: sin clave no se activa", () => {
  const { probe, trader } = setup();
  trader.enabled = false;
  assert.match(probe.setEnabled(true) ?? "", /no disponible/);
  assert.equal(probe.state().enabled, false);
});
