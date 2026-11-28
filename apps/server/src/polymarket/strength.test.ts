import { test } from "node:test";
import assert from "node:assert/strict";
import type { PmPoint } from "@updown/protocol";
import { BASE_STRENGTH, detectStrength, detectStrengthSet, strengthScore, withRefMove } from "./strength.js";

const T0 = 1_700_000_100_000;
/** muestras de 1 s con la P(Up) del motor dada por `p(segundo)` */
const series = (n: number, p: (s: number) => number): PmPoint[] =>
  Array.from({ length: n }, (_, s) => ({
    time: T0 + s * 1000,
    chainlink: 1,
    upBid: null,
    upAsk: null,
    downBid: null,
    downAsk: null,
    binance: 1,
    basis: null,
    sigma: null,
    flow: null,
    pModel: p(s),
  }));
// ruido pequeno y determinista alrededor de un nivel
const wiggle = (s: number) => 0.004 * Math.sin(s * 1.7);

test("SS: un salto brusco da UNA senal, en el segundo en que se detecta (durante la subida, no al final)", () => {
  // sube de 0.5 a 0.8 entre los segundos 60 y 66
  const pts = series(120, (s) => (s < 60 ? 0.5 : s < 66 ? 0.5 + (s - 59) * 0.05 : 0.8) + wiggle(s));
  const ev = detectStrength(pts, T0);
  assert.equal(ev.length, 1);
  const e = ev[0]!;
  assert.equal(e.dir, "up");
  const sec = (e.time - T0) / 1000;
  assert.ok(sec >= 60 && sec < 66, String(sec));
  assert.ok(Math.abs(e.p - pts[sec]!.pModel!) < 1e-12);
  assert.ok(e.move >= 0.08 && e.score >= 35, `${e.move} ${e.score}`);
});

test("SS es causal: con mas datos las senales pasadas no cambian", () => {
  const f = (s: number) => (s < 50 ? 0.6 : s < 54 ? 0.6 - (s - 49) * 0.08 : s < 90 ? 0.28 : s < 95 ? 0.28 + (s - 89) * 0.07 : 0.63) + wiggle(s);
  const full = detectStrength(series(140, f), T0);
  for (const cut of [53, 60, 92, 100]) {
    const part = detectStrength(series(cut, f), T0);
    assert.deepEqual(part, full.filter((e) => e.time < T0 + cut * 1000), String(cut));
  }
  assert.deepEqual(
    full.map((e) => e.dir),
    ["down", "up"],
  );
});

test("SS: el ruido, una deriva lenta y el calentamiento no dan senal", () => {
  assert.deepEqual(detectStrength(series(260, (s) => 0.5 + s * 0.001 + wiggle(s)), T0), []);
  assert.deepEqual(detectStrength(series(200, (s) => 0.5 + wiggle(s)), T0), []);
  assert.deepEqual(detectStrength(series(60, (s) => (s < 3 ? 0.5 : 0.8)), T0), []);
});

test("SS: puntuacion monotona y token Up de la referencia al detectar", () => {
  assert.ok(strengthScore(0.3, 8) > strengthScore(0.1, 8));
  assert.ok(strengthScore(0.1, 10) > strengthScore(0.1, 4));
  assert.ok(strengthScore(0.5, 20) <= 100 && strengthScore(0, 5) === 0);
  const ref = [
    { time: T0, up: 0.4, down: 0.6 },
    { time: T0 + 6_000, up: 0.55, down: 0.45 },
  ];
  const ev = { time: T0 + 6_000, dir: "up" as const, p: 0.6, from: 0.3, move: 0.3, seconds: 6, z: 9, score: 90 };
  const [e] = withRefMove([ev], ref);
  assert.ok(Math.abs(e!.refUpMove! - 0.15) < 1e-9);
  assert.equal(e!.refUp, 0.55);
  const [far] = withRefMove([{ ...ev, time: T0 + 66_000 }], ref);
  assert.equal(far!.refUpMove, null);
  assert.equal(far!.refUp, null);
});

test("SS base avisa una vez por subida larga y antes; SS Solana vuelve a avisar cada 45 s", () => {
  // 0.2 -> 0.9 en 70 s, constante y rapida respecto al ruido previo
  const pts = series(160, (s) => (s < 50 ? 0.2 : s < 120 ? 0.2 + (s - 50) * 0.01 : 0.9) + wiggle(s));
  const base = detectStrength(pts, T0, BASE_STRENGTH);
  assert.equal(base.length, 1);
  const set = detectStrengthSet(pts, T0);
  assert.deepEqual(set.base, base);
  assert.ok(set.sol.length >= 2 && set.sol.every((e) => e.dir === "up"), JSON.stringify(set.sol));
  // la calibrada exige mas fuerza: nunca avisa antes que la base
  assert.ok(set.sol[0]!.time >= base[0]!.time);
  assert.ok(set.sol[1]!.time - set.sol[0]!.time >= 45_000);
});
