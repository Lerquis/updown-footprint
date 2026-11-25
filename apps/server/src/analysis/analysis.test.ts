import { test } from "node:test";
import assert from "node:assert/strict";
import type { AggTrade, FootprintBar, FootprintLevel } from "@updown/protocol";
import {
  DEFAULT_DETECTOR,
  computeImbalances,
  detectAbsorption,
  detectCvdDivergence,
  detectExhaustion,
  detectStackedImbalances,
  type DetectorConfig,
} from "./detectors.js";
import { OrderflowEngine } from "./engine.js";
import { AnalysisMonitor, DEFAULT_MONITOR } from "./monitor.js";
import { evaluateScenarios, type ScenarioContext } from "./scenarios.js";

const cfg: DetectorConfig = { ...DEFAULT_DETECTOR, tick: 1, barMs: 60_000 };

function bar(levels: FootprintLevel[], o: Partial<FootprintBar> = {}): FootprintBar {
  const volume = levels.reduce((a, l) => a + l[1] + l[2], 0);
  const delta = levels.reduce((a, l) => a + l[2] - l[1], 0);
  const b: FootprintBar = {
    start: 0,
    open: levels[0]![0],
    high: levels[levels.length - 1]![0],
    low: levels[0]![0],
    close: levels[levels.length - 1]![0],
    volume,
    delta,
    cvdClose: 0,
    closed: true,
    levels,
    imbalances: [],
    ...o,
  };
  b.imbalances = o.imbalances ?? computeImbalances(levels, cfg);
  return b;
}

test("desequilibrios diagonales y apilados de compra", () => {
  // bid(100)=0.1; ask 101,102,103 >= 3x el bid del nivel inferior
  const b = bar([[100, 0.1, 0], [101, 0.2, 1], [102, 0.2, 2], [103, 0.1, 3]]);
  const buys = b.imbalances.filter((m) => m.side === "buy").map((m) => m.price);
  assert.deepEqual(buys, [101, 102, 103]);
  const [s] = detectStackedImbalances(b, cfg);
  assert.equal(s?.type, "stackedImbalance");
  assert.equal(s?.bias, "bullish");
  assert.equal(s?.strength, 3);
  assert.equal(s?.priceLo, 101);
  assert.equal(s?.priceHi, 104);
});

test("dos desequilibrios no son 'apilados'", () => {
  const b = bar([[100, 0.1, 0], [101, 0.2, 1], [102, 0.2, 2], [103, 5, 0.1]]);
  assert.equal(detectStackedImbalances(b, cfg).length, 0);
});

test("absorcion compradora: ventas agresivas en el minimo y el precio no baja", () => {
  const b = bar(
    [[100, 6, 0.5], [101, 4, 0.5], [102, 1, 1], [103, 1, 1], [104, 1, 2], [105, 1, 3], [106, 1, 3], [107, 1, 3]],
    { close: 106 },
  );
  const [s] = detectAbsorption(b, [], cfg);
  assert.equal(s?.type, "absorption");
  assert.equal(s?.bias, "bullish");
  assert.ok(s!.strength >= 0.3);
});

test("absorcion NO se marca si el precio cierra pegado al extremo", () => {
  const b = bar(
    [[100, 6, 0.5], [101, 4, 0.5], [102, 1, 1], [103, 1, 1], [104, 1, 2], [105, 1, 3], [106, 1, 3], [107, 1, 3]],
    { close: 100.5 },
  );
  assert.equal(detectAbsorption(b, [], cfg).length, 0);
});

test("agotamiento alcista: nuevo maximo con volumen casi nulo en el extremo", () => {
  const prev = bar([[100, 5, 5], [105, 5, 5]], { volume: 100, high: 105 });
  const b = bar([[104, 1, 1], [105, 1, 1], [106, 1, 1], [107, 0.01, 0.01], [108, 0.01, 0.01]]);
  const [s] = detectExhaustion(b, [prev], cfg);
  assert.equal(s?.type, "exhaustion");
  assert.equal(s?.bias, "bearish");
});

test("agotamiento NO si el extremo tiene volumen real", () => {
  const prev = bar([[100, 5, 5], [105, 5, 5]], { volume: 100, high: 105 });
  const b = bar([[104, 1, 1], [105, 1, 1], [106, 1, 1], [107, 2, 2], [108, 2, 2]]);
  assert.equal(detectExhaustion(b, [prev], cfg).length, 0);
});

test("divergencia bajista de CVD: maximo mas alto con CVD mas bajo", () => {
  const mk = (start: number, high: number, cvd: number) => bar([[high - 2, 5, 5], [high, 5, 5]], { start, high, cvdClose: cvd });
  const prev = [mk(0, 105, 10), mk(60_000, 106, 20), mk(120_000, 107, 30)];
  const cur = mk(180_000, 110, 5);
  const [s] = detectCvdDivergence(cur, prev, cfg);
  assert.equal(s?.type, "cvdDivergence");
  assert.equal(s?.bias, "bearish");
  assert.equal(s?.link?.from.price, 107);
  assert.equal(s?.link?.to.price, 110);
});

test("divergencia alcista de CVD: minimo mas bajo con CVD mas alto", () => {
  const mk = (start: number, low: number, cvd: number) => bar([[low, 5, 5], [low + 2, 5, 5]], { start, low, cvdClose: cvd });
  const prev = [mk(0, 100, -10), mk(60_000, 99, -20), mk(120_000, 98, -30)];
  const cur = mk(180_000, 95, -5);
  const [s] = detectCvdDivergence(cur, prev, cfg);
  assert.equal(s?.bias, "bullish");
});

test("motor: barras footprint, delta y CVD con el lado correcto", () => {
  const base = 1_700_000_040_000; // multiplo de 60 s
  const engine = new OrderflowEngine({ barMs: 60_000, barHistory: 10, tick: 1, retentionMs: 900_000, detector: cfg });
  const t = (id: number, ms: number, price: number, quantity: number, sell: boolean): AggTrade => ({
    id, symbol: "X", price, quantity, time: base + ms, isBuyerMaker: sell,
  });
  engine.ingest(t(1, 0, 100.2, 1, false)); // compra agresiva -> ask
  engine.ingest(t(2, 500, 100.7, 0.5, true)); // venta agresiva -> bid (mismo nivel 100)
  engine.ingest(t(3, 2_500, 101.1, 2, false));
  engine.ingest(t(4, 61_000, 101, 1, true)); // abre la barra siguiente -> cierra la primera

  assert.equal(engine.bars.length, 1);
  const b = engine.bars[0]!;
  assert.deepEqual(b.levels, [[100, 0.5, 1], [101, 0, 2]]);
  assert.equal(b.volume, 3.5);
  assert.equal(b.delta, 2.5);
  assert.equal(b.cvdClose, 2.5);
  assert.equal(b.closed, true);
  assert.equal(b.open, 100.2);
  assert.equal(b.close, 101.1);
  assert.equal(engine.currentCvd, 1.5);
  assert.ok(engine.cvdPoints.length >= 60);
});

test("escenario del enunciado: agotamiento vendedor + CVD sube + precio baja => giro alcista", () => {
  const ctx: ScenarioContext = { priceTrend: "down", cvdTrend: "up", has: (type, bias) => type === "exhaustion" && bias === "bullish" };
  const r = evaluateScenarios(ctx);
  const top = r.scenarios[0]!;
  assert.equal(top.id, "exhaustion-down-reversal");
  assert.equal(top.weight, 3);
  assert.ok(r.scenarios.some((s) => s.id === "down-cvd-up"));
  assert.equal(r.bias, "bullish");
});

test("escenarios: subida confirmada sin senales, y contradiccion => mixed", () => {
  const plain = evaluateScenarios({ priceTrend: "up", cvdTrend: "up", has: () => false });
  assert.deepEqual(plain.scenarios.map((s) => s.id), ["up-confirmed"]);

  const mixed = evaluateScenarios({
    priceTrend: "flat",
    cvdTrend: "flat",
    has: (type, bias) => (type === "exhaustion" && bias === "bearish") || (type === "absorption" && bias === "bullish"),
  });
  assert.ok(mixed.scenarios.some((s) => s.id === "mixed"));
  assert.equal(mixed.bias, "neutral");
});

test("escenarios: dos senales alcistas => confluencia", () => {
  const r = evaluateScenarios({
    priceTrend: "up",
    cvdTrend: "up",
    has: (type, bias) => bias === "bullish" && (type === "stackedImbalance" || type === "cvdDivergence"),
  });
  assert.ok(r.scenarios.some((s) => s.id === "confluence-bullish"));
  assert.equal(r.bias, "bullish");
});

test("monitor: precio y CVD subiendo => tendencias 'up'", () => {
  const base = 1_700_000_040_000;
  const engine = new OrderflowEngine({ barMs: 60_000, barHistory: 10, tick: 1, retentionMs: 900_000, detector: cfg });
  for (let i = 0; i <= 120; i++) {
    engine.ingest({ id: i + 1, symbol: "X", price: 100 + i * 0.1, quantity: 1, time: base + i * 1000, isBuyerMaker: false });
  }
  const monitor = new AnalysisMonitor(engine, { ...DEFAULT_MONITOR, lookbackMs: 60_000, recentBars: 3, barMs: 60_000 });
  const r = monitor.update();
  assert.ok(r);
  assert.equal(r.summary.priceTrend, "up");
  assert.equal(r.summary.cvdTrend, "up");
  assert.ok(r.summary.scenarios.some((s) => s.id === "up-confirmed"));
  assert.equal(r.changed, true);
  assert.equal(monitor.update()?.changed, false);
});
