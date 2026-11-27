import { test } from "node:test";
import assert from "node:assert/strict";
import type { AggTrade, PmMarket, PmOrder } from "@updown/protocol";
import { bookImbalance, DEFAULT_DRIFT, driftScore, MicroFlow, predictDrift } from "./micro.js";
import { TokenBook, walkBook } from "./pmBook.js";
import { DEFAULT_PREDICTIVE, PredictiveEngine, type FastInput } from "./predictive.js";
import { DEFAULT_MAKER, MakerEngine, reconcile, type MakerWants } from "./maker.js";
import { PaperMaker, PaperTaker } from "./paper.js";
import { FastRunner } from "./fastRunner.js";
import { PmFeed } from "./timedEngine.js";

const T0 = 1_800_000_000_000;
const market = (k: number | null = 60_000): PmMarket => ({
  slug: "btc-updown-5m-x",
  title: "",
  start: T0,
  end: T0 + 300_000,
  upToken: "u",
  downToken: "d",
  status: "live",
  priceToBeat: k,
  closePrice: null,
  changePct: null,
  result: null,
});
const trade = (id: number, time: number, price: number, qty = 0.1, sell = false): AggTrade => ({ id, symbol: "BTCUSDT", price, quantity: qty, time, isBuyerMaker: sell });

const input = (over: Partial<FastInput> = {}): FastInput => ({
  time: T0 + 100_000,
  binance: 60_000,
  basis: 0,
  chainlink: 60_000,
  sigma: 5,
  drift: 0,
  z: 0,
  up: { bid: 0.49, ask: 0.5 },
  down: { bid: 0.5, ask: 0.51 },
  ...over,
});

// ───────────── micro ─────────────

test("micro: OFI, momentum y desequilibrio del libro con el signo correcto", () => {
  const mf = new MicroFlow();
  const t = T0;
  mf.add(trade(1, t - 3500, 100));
  mf.add(trade(2, t - 2500, 100, 1, true)); // venta (dentro de 3 s, fuera de 1 s)
  mf.add(trade(3, t - 500, 101, 1)); // compra
  mf.add(trade(4, t - 200, 102, 1)); // compra
  const f = mf.features(t, 1, 0.5)!;
  assert.equal(f[0], 1); // ofi1: solo compras
  assert.ok(Math.abs(f[1]! - 1 / 3) < 1e-9); // ofi3: 2 compra - 1 venta / 3
  assert.equal(f[2], 2); // ret1: (102 - 100) / (1 · raiz(1))
  assert.ok(Math.abs(f[3]! - 2 / Math.sqrt(3)) < 1e-9); // ret3: precio a t-3 s = 100
  assert.equal(f[4], 0.5);
  assert.equal(mf.features(t, null, 0), null); // sin sigma no hay variables
  assert.equal(bookImbalance([[99, 3], [90, 100]], [[101, 1]], 100, 5), 0.5); // el nivel de 90 queda fuera del rango
});

test("micro: la deriva tiene el signo del flujo, crece con raiz del horizonte y se acota", () => {
  const up = predictDrift([1, 1, 1, 1, 1], 4, 100);
  const down = predictDrift([-1, -1, -1, -1, -1], 4, 100);
  assert.ok(up > 0 && down < 0 && Math.abs(up + down) < 1e-9);
  assert.ok(predictDrift([1, 1, 1, 1, 1], 4, 4) < up); // menos tiempo restante, menos deriva
  const huge = predictDrift([50, 50, 50, 50, 50], 4, 100);
  assert.equal(huge, DEFAULT_DRIFT.maxZ * 4 * Math.sqrt(DEFAULT_DRIFT.horizonS));
  assert.ok(driftScore([0, 0, 0, 0, 1]) > 0);
});

// ───────────── libro y papel taker ─────────────

test("walkBook: recorre niveles sin pasar del limite", () => {
  const asks: [number, number][] = [[0.5, 10], [0.52, 10], [0.6, 100]];
  const w = walkBook(asks, "buy", 10, 0.55); // 10 USDC: 10 tokens a 0.5 = 5 USDC, luego 5/0.52
  assert.ok(Math.abs(w.usd - 10) < 1e-9);
  assert.ok(Math.abs(w.shares - (10 + 5 / 0.52)) < 1e-9);
  const lim = walkBook(asks, "buy", 100, 0.51); // solo el primer nivel cabe en el limite
  assert.equal(lim.shares, 10);
  const sell = walkBook([[0.48, 5], [0.4, 5]], "sell", 8, 0.45);
  assert.equal(sell.shares, 5);
});

test("PaperTaker: ejecuta con retraso contra el libro de ese instante y respeta el limite", () => {
  const book = new TokenBook();
  book.snapshot([[0.48, 100]], [[0.5, 100]], T0);
  const pt = new PaperTaker(1500, 0.05);
  const sig = { id: "s1", slug: "x", time: T0, action: "buy" as const, side: "up" as const, reason: "entry" as const, price: 0.5, fee: 0, shares: 20, amount: 10, pSide: 0.7, edge: 0.15, tau: 100, limit: 0.55 };
  pt.submit(sig, "u", T0);
  assert.equal(pt.resolve(T0 + 1000, () => book, T0 + 300_000).length, 0); // aun no vence
  book.snapshot([[0.58, 100]], [[0.6, 100]], T0 + 1200); // el mercado se fue por encima del limite
  const [miss] = pt.resolve(T0 + 1500, () => book, T0 + 300_000);
  assert.equal(miss!.filled, null);

  pt.submit({ ...sig, id: "s2" }, "u", T0 + 2000);
  book.snapshot([[0.5, 100]], [[0.52, 100]], T0 + 3000);
  const [hit] = pt.resolve(T0 + 3500, () => book, T0 + 300_000);
  assert.ok(hit!.filled);
  assert.equal(hit!.filled!.price, 0.52);
  assert.equal(hit!.filled!.signalPrice, 0.5);
  assert.ok(Math.abs(hit!.usd - 10) < 0.01); // el importe incluye la comision
});

// ───────────── motor D ─────────────

test("motor D: compra con EV >= minEdge y limite que conserva margen; sin ejecucion puede reintentar", () => {
  const cfg = { ...DEFAULT_PREDICTIVE, warmupS: 0, cooldownS: 0 };
  const eng = new PredictiveEngine(market(59_900), cfg); // precio 100 USD por encima del price to beat
  const r = eng.step(input({ up: { bid: 0.4, ask: 0.41 }, down: { bid: 0.58, ask: 0.6 } }));
  const buy = r.signals.find((s) => s.action === "buy" && s.side === "up");
  assert.ok(buy, `deberia comprar Up (pUp ${r.fair?.pUp})`);
  assert.ok(buy!.limit! >= buy!.price && buy!.limit! < r.fair!.pUp, "el limite queda entre el ask y la probabilidad");
  assert.equal(r.decision.up.buy, "ok");
  // mientras espera la ejecucion no repite
  assert.equal(eng.step(input({ time: T0 + 100_100, up: { bid: 0.4, ask: 0.41 }, down: { bid: 0.58, ask: 0.6 } })).decision.up.buy, "pending");
  eng.onFill(buy!.id, null); // el limite la protegio: no se ejecuto
  const again = eng.step(input({ time: T0 + 100_200, up: { bid: 0.4, ask: 0.41 }, down: { bid: 0.58, ask: 0.6 } }));
  assert.ok(again.signals.some((s) => s.action === "buy" && s.side === "up"), "puede reintentar");
});

test("motor D: no compra con EV pequeno ni en los ultimos segundos; vende cuando vender vale mas que mantener", () => {
  const cfg = { ...DEFAULT_PREDICTIVE, warmupS: 0, cooldownS: 0 };
  const flat = new PredictiveEngine(market(60_000), cfg);
  assert.equal(flat.step(input()).signals.length, 0); // mercado justo: sin ventaja
  const late = new PredictiveEngine(market(59_900), cfg);
  assert.equal(late.step(input({ time: T0 + 290_000, up: { bid: 0.4, ask: 0.41 } })).decision.up.buy, "closing");

  const eng = new PredictiveEngine(market(59_900), cfg);
  const buy = eng.step(input({ up: { bid: 0.4, ask: 0.41 }, down: { bid: 0.58, ask: 0.6 } })).signals[0]!;
  eng.onFill(buy.id, { shares: 100, usd: 42 });
  assert.equal(eng.shares("up"), 100);
  // Binance vuelve al price to beat pero el token Up sigue carisimo: vale mas vender que mantener
  const r = eng.step(input({ time: T0 + 101_000, binance: 59_900, up: { bid: 0.97, ask: 0.98 }, down: { bid: 0.02, ask: 0.03 } }));
  const sell = r.signals.find((s) => s.action === "sell");
  assert.ok(sell && sell.side === "up" && sell.limit! <= 0.97);
  eng.onFill(sell!.id, { shares: 100, usd: 95 });
  assert.equal(eng.shares("up"), 0);
});

test("motor D: la deriva de Binance adelanta la decision", () => {
  const cfg = { ...DEFAULT_PREDICTIVE, warmupS: 0, cooldownS: 0 };
  const q = { up: { bid: 0.47, ask: 0.48 }, down: { bid: 0.52, ask: 0.53 } };
  const no = new PredictiveEngine(market(60_000), cfg).step(input(q));
  const yes = new PredictiveEngine(market(60_000), cfg).step(input({ ...q, drift: 60, z: 0.5 }));
  assert.equal(no.signals.length, 0);
  assert.ok(yes.signals.some((s) => s.side === "up" && s.action === "buy"));
});

// ───────────── motor E ─────────────

test("reconcile: coloca lo que falta, mantiene lo cercano, recoloca lo lejano y cancela con motivo", () => {
  const o = (id: string, price: number, placedAt = 0, over: Partial<PmOrder> = {}): PmOrder => ({
    id, slug: "x", side: "up", action: "buy", price, shares: 10, placedAt, liveAt: placedAt, cancelAt: null, queueAhead: 0, filledShares: 0, filledAt: null, status: "open", cancelReason: null, ...over,
  });
  const wants = (bid: MakerWants["bid"]["up"]): MakerWants => ({ bid: { up: bid, down: { cancel: "edge" } }, ask: { up: { cancel: "edge" }, down: { cancel: "edge" } } });
  const cfg = { repriceMin: 0.02, minRestMs: 500 };
  assert.deepEqual(reconcile([], wants({ price: 0.4, shares: 10 }), 1000, cfg), [{ type: "place", side: "up", action: "buy", price: 0.4, shares: 10 }]);
  assert.deepEqual(reconcile([o("a", 0.41)], wants({ price: 0.4, shares: 10 }), 1000, cfg), []); // 1c: se queda
  assert.deepEqual(reconcile([o("a", 0.45)], wants({ price: 0.4, shares: 10 }), 1000, cfg), [{ type: "cancel", id: "a", reason: "reprice" }]);
  assert.deepEqual(reconcile([o("a", 0.45, 900)], wants({ price: 0.4, shares: 10 }), 1000, cfg), []); // aun no toca recolocar
  assert.deepEqual(reconcile([o("a", 0.4, 900)], wants({ cancel: "drift" }), 1000, cfg), [{ type: "cancel", id: "a", reason: "drift" }]);
  // con una cancelacion en curso no se coloca otra
  assert.deepEqual(reconcile([o("a", 0.45, 0, { cancelAt: 1100 })], wants({ price: 0.4, shares: 10 }), 1000, cfg), []);
});

test("motor E: cotiza la entrada solo con el flujo a favor y bajo su valor; cancela si se gira", () => {
  const cfg = { ...DEFAULT_MAKER, warmupS: 0 };
  const eng = new MakerEngine(market(59_995), cfg);
  const q = { up: { bid: 0.45, ask: 0.47 }, down: { bid: 0.53, ask: 0.55 } };
  const noFlow = eng.step(input({ ...q, z: 0 }), []);
  assert.ok("cancel" in noFlow.wants.bid.up && noFlow.decision.up.buy === "drift");
  const r = eng.step(input({ ...q, time: T0 + 100_100, z: 0.2 }), []);
  const want = r.wants.bid.up;
  assert.ok(!("cancel" in want), `deberia cotizar Up (pUp ${r.fair?.pUp})`);
  if (!("cancel" in want)) {
    assert.ok(want.price <= 0.45 + cfg.join + 1e-9 && want.price < 0.47, "mejora el mejor bid como mucho `join` y nunca cruza el ask");
    assert.ok(r.fair!.pUp - want.price >= cfg.edge - 1e-9);
  }
  assert.ok("cancel" in r.wants.bid.down); // el flujo empuja contra Down
  const turned = eng.step(input({ ...q, time: T0 + 100_200, z: -0.2 }), []);
  assert.deepEqual(turned.wants.bid.up, { cancel: "drift" });
});

test("motor E: tras ejecutarse cotiza la salida por encima del valor y sale como taker si la idea muere", () => {
  const cfg = { ...DEFAULT_MAKER, warmupS: 0 };
  const eng = new MakerEngine(market(59_995), cfg);
  const q = { up: { bid: 0.45, ask: 0.47 }, down: { bid: 0.53, ask: 0.55 } };
  eng.step(input({ ...q, z: 0.2 }), []);
  const order: PmOrder = { id: "o", slug: "x", side: "up", action: "buy", price: 0.45, shares: 20, placedAt: 0, liveAt: 0, cancelAt: null, queueAhead: 0, filledShares: 20, filledAt: 1, status: "filled", cancelReason: null };
  const sig = eng.onMakerFill(order, 20, T0 + 100_050);
  assert.equal(sig.fee, 0);
  assert.equal(sig.maker, true);
  assert.equal(eng.shares("up"), 20);
  const r = eng.step(input({ ...q, time: T0 + 100_100, z: 0.2 }), []);
  const ask = r.wants.ask.up;
  assert.ok(!("cancel" in ask) && ask.price >= r.fair!.pUp + cfg.exitEdge - 1e-9);
  // Binance se hunde: la probabilidad de Up cae muy por debajo de la entrada -> salida de emergencia
  const crash = eng.step(input({ ...q, time: T0 + 101_000, binance: 59_900, up: { bid: 0.2, ask: 0.22 }, down: { bid: 0.78, ask: 0.8 } }), []);
  const stop = crash.signals.find((s) => s.action === "sell" && s.side === "up");
  assert.ok(stop && stop.limit !== undefined);
  assert.deepEqual(crash.wants.ask.up, { cancel: "stop" });
});

// ───────────── papel maker ─────────────

test("PaperMaker: entra al final de la cola, se ejecuta cuando los trades la consumen o la atraviesan", () => {
  const book = new TokenBook();
  book.snapshot([[0.45, 30]], [[0.47, 50]], T0);
  const pm = new PaperMaker("x", { postLatencyMs: 150, cancelLatencyMs: 100 });
  const o = pm.place("up", "buy", 0.45, 20, "u", T0);
  pm.advance(T0 + 100, () => book);
  assert.equal(pm.open()[0]!.status, "pending");
  pm.advance(T0 + 150, () => book);
  assert.equal(pm.open()[0]!.queueAhead, 30);
  // trades de venta en nuestro precio consumen la cola: 25 no llegan; 10 mas -> se ejecutan 5
  assert.equal(pm.onTrade({ token: "u", price: 0.45, size: 25, side: "sell", time: 0 }, T0 + 200).length, 0);
  const [f1] = pm.onTrade({ token: "u", price: 0.45, size: 10, side: "sell", time: 0 }, T0 + 300);
  assert.equal(f1!.shares, 5);
  // un trade por debajo de nuestro precio nos atraviesa: se ejecuta el resto
  const [f2] = pm.onTrade({ token: "u", price: 0.44, size: 100, side: "sell", time: 0 }, T0 + 400);
  assert.equal(f2!.shares, 15);
  assert.equal(pm.all().find((x) => x.id === o.id)!.status, "filled");
  // un trade de compra (taker comprando) en nuestro precio no nos toca
  const o2 = pm.place("up", "buy", 0.45, 20, "u", T0 + 500);
  pm.advance(T0 + 700, () => book);
  assert.equal(pm.onTrade({ token: "u", price: 0.45, size: 1000, side: "buy", time: 0 }, T0 + 800).length, 0);
  assert.equal(pm.all().find((x) => x.id === o2.id)!.filledShares, 0);
});

test("PaperMaker: cancelar tarda y mientras tanto se puede ejecutar; post-only rechaza lo que cruzaria", () => {
  const book = new TokenBook();
  book.snapshot([[0.45, 0]], [[0.47, 50]], T0);
  const pm = new PaperMaker("x", { postLatencyMs: 150, cancelLatencyMs: 100 });
  const o = pm.place("up", "buy", 0.45, 20, "u", T0);
  pm.advance(T0 + 150, () => book);
  pm.cancel(o.id, T0 + 200, "drift");
  const [f] = pm.onLevel("u", "ask", 0.44, 10, T0 + 250); // un ask cruza nuestro bid antes de que la cancelacion llegue
  assert.equal(f!.shares, 10);
  pm.advance(T0 + 300, () => book);
  const done = pm.all().find((x) => x.id === o.id)!;
  assert.equal(done.status, "cancelled");
  assert.equal(done.cancelReason, "drift");
  assert.equal(done.filledShares, 10);
  // nivel de nuestro precio que encoge sin trades: la cola por delante no puede ser mayor que el nivel
  book.snapshot([[0.45, 40]], [[0.47, 50]], T0 + 400);
  const o2 = pm.place("up", "buy", 0.45, 5, "u", T0 + 400);
  pm.advance(T0 + 600, () => book);
  pm.onLevel("u", "bid", 0.45, 3, T0 + 700);
  assert.equal(pm.all().find((x) => x.id === o2.id)!.queueAhead, 3);
  // post-only: una compra que al entrar ya cruzaria el ask se rechaza
  const o3 = pm.place("up", "buy", 0.47, 5, "u", T0 + 800);
  pm.advance(T0 + 1000, () => book);
  assert.equal(pm.all().find((x) => x.id === o3.id)!.status, "cancelled");
});

// ───────────── runner ─────────────

test("FastRunner: una muestra por segundo por motor, ordenes en papel y cancelacion al cambiar de market", () => {
  const feed = new PmFeed();
  const runner = new FastRunner(
    {
      tickMs: 100,
      retentionMs: 900_000,
      decisionsMax: 400,
      twapSeconds: 60,
      predictive: { ...DEFAULT_PREDICTIVE, warmupS: 0 },
      maker: { ...DEFAULT_MAKER, warmupS: 0 },
      drift: DEFAULT_DRIFT,
      paper: { takerLatencyMs: 1500, postLatencyMs: 150, cancelLatencyMs: 100 },
    },
    feed,
    () => null,
  );
  const steps: string[] = [];
  const orders: PmOrder[] = [];
  runner.on("step", (s) => steps.push(`${s.engine}${s.point.time}`));
  runner.on("order", (_slug, o) => orders.push(o));
  let id = 0;
  // historia de Binance para la volatilidad, y compras agresivas al final (flujo a favor de Up)
  for (let t = T0 - 200_000; t < T0 + 30_000; t += 250) runner.addTrade(trade(id++, t, 60_000 + Math.sin(t / 7000) * 5, 0.1, t < T0 + 25_000 && id % 2 === 0));
  runner.onBook("u", [[0.44, 50]], [[0.46, 50]], T0);
  runner.onBook("d", [[0.54, 50]], [[0.56, 50]], T0);
  const m = market(59_997);
  for (let t = T0 - 120_000; t < T0 + 30_000; t += 1000) feed.onChainlink(t, 60_000);
  for (let t = T0 + 1000; t < T0 + 30_000; t += 100) runner.tick(t, m);
  assert.ok(steps.filter((s) => s.startsWith("d")).length >= 28);
  assert.equal(steps.filter((s) => s.startsWith("d")).length, steps.filter((s) => s.startsWith("e")).length);
  assert.ok(runner.decisions.d.length > 0 && runner.decisions.e.length > 0);
  // si E coloco algo, al cambiar de market todo queda cancelado
  runner.tick(T0 + 300_500, { ...m, slug: "otro", start: T0 + 300_000, end: T0 + 600_000 });
  const last = new Map(orders.map((o) => [o.id, o]));
  for (const o of last.values()) assert.ok(o.status === "cancelled" || o.status === "filled", `${o.id} ${o.status}`);
});
