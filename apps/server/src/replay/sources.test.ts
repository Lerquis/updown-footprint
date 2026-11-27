import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSnapshots, pickV1Archives } from "./sources.js";

const o = (key: string, size: number, lastModified: number) => ({ key, size, lastModified });

test("copias horarias: la ultima de cada tramo (antes de que la base se vacie) y la mas reciente", () => {
  const picked = pickSnapshots(
    [
      o("updown/v2/polymarket-3.db.gz", 2_000, 3),
      o("updown/v2/polymarket-1.db.gz", 10_000, 1),
      o("updown/v2/polymarket-2.db.gz", 12_000, 2),
      o("updown/v2/latest.json", 50, 4),
      o("updown/v2/polymarket-4.db.gz", 3_000, 4),
    ],
    "updown/v2/",
  );
  assert.deepEqual(
    picked.map((x) => x.key),
    ["updown/v2/polymarket-2.db.gz", "updown/v2/polymarket-4.db.gz"],
  );
});

test("v1: las copias de la raiz del prefijo, sin mezclar las de v2/ ni archive/", () => {
  const all = [
    o("updown/polymarket-2026-11-24.db.gz", 100, 1),
    o("updown/polymarket-2026-11-25.db.gz", 150, 2),
    o("updown/latest.json", 1, 3),
    o("updown/v2/polymarket-2026-11-26.db.gz", 10, 4),
    o("updown/archive/polymarket-railway-x.db.gz", 160, 5),
  ];
  assert.deepEqual(
    pickSnapshots(all, "updown/").map((x) => x.key),
    ["updown/polymarket-2026-11-25.db.gz"],
  );
});

test("archivo v1: solo el del servidor remoto, no el subido desde el PC", () => {
  const picked = pickV1Archives([o("updown/archive/polymarket-local-a.db.gz", 1, 1), o("updown/archive/polymarket-railway-b.db.gz", 1, 2)]);
  assert.deepEqual(
    picked.map((x) => x.key),
    ["updown/archive/polymarket-railway-b.db.gz"],
  );
});
