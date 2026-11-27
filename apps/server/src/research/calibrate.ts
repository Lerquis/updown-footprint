import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { MICRO_FEATURES } from "../polymarket/micro.js";
import type { Calibration } from "../polymarket/serverStrategy.js";

/**
 * Recalcula los coeficientes de la deriva de los motores D y E con los aggTrades y el heatmap guardados
 * (docs/features/predictive-engines.md):
 *   npm run calibrate -w @updown/server [-- base1.db base2.db ...]
 * Por defecto usa la base actual y la de la generacion anterior. Rejilla de 1 s; variables como en `micro.ts` (mas otras 7 de
 * control: OFI de 10/30 s, retornos de 10/30 s, trades grandes, libro a 20 USD e intensidad); objetivo: retorno de los proximos
 * 30 s en sigmas por raiz(30). OLS con 70 % de entrenamiento y 30 % de prueba (cronologico). Escribe PM_CALIBRATION_PATH,
 * que el servidor lee al arrancar. El multiplicador PM_DRIFT_GAIN (3) se ajusto con los coeficientes por defecto.
 */

const files = process.argv.slice(2).length ? process.argv.slice(2) : [config.pmLegacyDbPath, config.pmDbPath].filter((f) => existsSync(f));
if (!files.length) {
  console.error("[calibrate] no hay bases de datos");
  process.exit(1);
}

type Row = { id: number; time: number; price: number; qty: number; sell: number };
const trades: Row[] = [];
const depth = new Map<number, { mid: number; lo: number; step: number; q: Float32Array }>();
let lastId = 0;
for (const f of files) {
  const db = new DatabaseSync(f, { readOnly: true });
  const rows = db.prepare("SELECT id, time, price, qty, sell FROM agg_trades WHERE id > ? ORDER BY id").all(lastId) as Row[];
  for (const t of rows) trades.push(t);
  if (trades.length) lastId = trades[trades.length - 1]!.id;
  for (const r of db.prepare("SELECT time, mid, lo, step, q FROM depth_columns").all() as { time: number; mid: number; lo: number; step: number; q: Uint8Array }[]) {
    const c = new Uint8Array(r.q);
    depth.set(Math.floor(r.time / 1000), { mid: r.mid, lo: r.lo, step: r.step, q: new Float32Array(c.buffer, 0, c.byteLength / 4) });
  }
  db.close();
  console.log(`[calibrate] ${f}: ${rows.length} aggTrades`);
}
if (trades.length < 100_000) {
  console.error(`[calibrate] solo ${trades.length} aggTrades: hacen falta horas de datos`);
  process.exit(1);
}

// rejilla de 1 s
const t0 = Math.floor(trades[0]!.time / 1000);
const N = Math.floor(trades[trades.length - 1]!.time / 1000) - t0 + 1;
const px = new Float64Array(N).fill(NaN);
const buy = new Float64Array(N);
const sell = new Float64Array(N);
const bigB = new Float64Array(N);
const bigS = new Float64Array(N);
const cnt = new Float64Array(N);
for (const t of trades) {
  const i = Math.floor(t.time / 1000) - t0;
  px[i] = t.price;
  (t.sell ? sell : buy)[i]! += t.qty;
  if (t.qty >= 0.5) (t.sell ? bigS : bigB)[i]! += t.qty;
  cnt[i]!++;
}
for (let i = 1; i < N; i++) if (Number.isNaN(px[i])) px[i] = px[i - 1]!;
const sum = (a: Float64Array, i: number, w: number) => {
  let s = 0;
  for (let j = Math.max(0, i - w + 1); j <= i; j++) s += a[j]!;
  return s;
};
const imbAt = (s: number, k: number) => {
  const d = depth.get(s);
  if (!d) return Number.NaN;
  let b = 0;
  let a = 0;
  for (let j = 0; j < d.q.length; j++) {
    const p = d.lo + j * d.step;
    if (p < d.mid && p >= d.mid - k) b += d.q[j]!;
    else if (p >= d.mid && p <= d.mid + k) a += d.q[j]!;
  }
  return b + a > 0 ? (b - a) / (b + a) : 0;
};

// las 5 del motor primero (mismo orden que MICRO_FEATURES), luego las de control
const H = [1, 5, 10, 30];
const X: number[][] = [];
const Y: Record<number, number[]> = Object.fromEntries(H.map((h) => [h, []]));
for (let i = 400; i + 30 < N; i++) {
  if (cnt[i] === 0 && cnt[i - 1] === 0 && cnt[i - 2] === 0) continue; // hueco de datos
  let v = 0;
  let n = 0;
  for (let j = i - 300; j <= i; j += 5) {
    const r = px[j]! - px[j - 5]!;
    v += r * r;
    n++;
  }
  const sig = Math.sqrt(v / n / 5);
  if (!(sig > 0)) continue;
  const ofi = (w: number) => {
    const b = sum(buy, i, w);
    const s = sum(sell, i, w);
    return b + s > 0 ? (b - s) / (b + s) : 0;
  };
  const ret = (w: number) => (px[i]! - px[i - w]!) / (sig * Math.sqrt(w));
  const f = [
    ofi(1), ofi(3), ret(1), ret(3), imbAt(i + t0, 5),
    ofi(10), ofi(30), ret(10), ret(30), Math.tanh((sum(bigB, i, 5) - sum(bigS, i, 5)) / 5), imbAt(i + t0, 20),
    Math.log(sum(cnt, i, 10) / Math.max(1, sum(cnt, i - 10, 290) / 29) + 0.1),
  ];
  if (f.some((x) => !Number.isFinite(x))) continue;
  X.push(f);
  for (const h of H) Y[h]!.push((px[i + h]! - px[i]!) / (sig * Math.sqrt(h)));
}
console.log(`[calibrate] ${X.length} muestras de 1 s`);

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j]! -= k * M[c]![j]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}
function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb);
    aa += (a[i]! - ma) ** 2;
    bb += (b[i]! - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}
const split = Math.floor(X.length * 0.7);
const fit = (y: number[]) => {
  const k = X[0]!.length + 1;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < split; i++) {
    const x = [1, ...X[i]!];
    for (let a = 0; a < k; a++) {
      b[a]! += x[a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += x[a]! * x[c]!;
    }
  }
  for (let a = 1; a < k; a++) A[a]![a]! += split * 0.01; // ridge leve
  const beta = solve(A, b);
  const pred = X.slice(split).map((x) => beta[0]! + x.reduce((s, v, j) => s + v * beta[j + 1]!, 0));
  return { beta: beta.slice(1), out: corr(pred, y.slice(split)) };
};

const outOfSample: Record<string, number> = {};
let betas: number[] = [];
for (const h of H) {
  const r = fit(Y[h]!);
  outOfSample[`${h}s`] = Math.round(r.out * 1000) / 1000;
  console.log(`[calibrate] h=${h}s correlacion fuera de muestra ${r.out.toFixed(3)}`);
  if (h === 30) betas = r.beta.slice(0, MICRO_FEATURES.length).map((b) => Math.round(b * 10000) / 10000);
}
const cal: Calibration = { createdAt: new Date().toISOString(), features: [...MICRO_FEATURES], betas, outOfSample, samples: X.length };
const out = config.pmFast.calibrationPath;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(cal, null, 2));
console.log(`[calibrate] ${MICRO_FEATURES.map((f, i) => `${f}=${betas[i]}`).join(" ")} -> ${out} (se usa al reiniciar el servidor)`);
