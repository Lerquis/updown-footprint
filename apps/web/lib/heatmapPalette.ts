/**
 * Paletas del heatmap. Verde = liquidez de COMPRA (bids, debajo del precio);
 * rojo = liquidez de VENTA (asks, encima del precio). Mas claro/brillante = mas liquidez.
 * Compartida por el canvas (LUT) y la leyenda (gradiente CSS) para que siempre coincidan.
 */
type RGB = [number, number, number];

const BUY_STOPS: RGB[] = [
  [8, 14, 14],
  [10, 70, 50],
  [16, 150, 95],
  [60, 220, 140],
  [210, 255, 228],
];

const SELL_STOPS: RGB[] = [
  [14, 10, 12],
  [90, 20, 35],
  [190, 40, 60],
  [250, 100, 100],
  [255, 222, 212],
];

const rgb = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

function buildLut(stops: RGB[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(f));
    const u = f - k;
    const a = stops[k]!;
    const b = stops[k + 1]!;
    out.push(rgb([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]));
  }
  return out;
}

const gradient = (stops: RGB[]) => `linear-gradient(to right, ${stops.map(rgb).join(", ")})`;

export const BUY_LUT = buildLut(BUY_STOPS);
export const SELL_LUT = buildLut(SELL_STOPS);
export const BUY_GRADIENT = gradient(BUY_STOPS);
export const SELL_GRADIENT = gradient(SELL_STOPS);
