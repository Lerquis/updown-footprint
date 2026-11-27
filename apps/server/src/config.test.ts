import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { resolveDbPath } from "./config.js";

// rutas construidas con node:path para que la prueba valga en Linux (Railway) y en Windows
const VOL = "/data";
const inVol = (...p: string[]) => join(resolve(VOL), ...p);

test("resolveDbPath: sin volumen se respeta la ruta pedida", () => {
  assert.equal(resolveDbPath("data/polymarket.db", undefined), "data/polymarket.db");
});

test("resolveDbPath: ruta fuera del volumen -> mismo archivo dentro del volumen (caso Railway 27 nov)", () => {
  assert.equal(resolveDbPath("data/polymarket.db", VOL), inVol("polymarket.db"));
  assert.equal(resolveDbPath("/app/data/polymarket.db", VOL), inVol("polymarket.db"));
  // /database no esta dentro de /data aunque empiece igual
  assert.equal(resolveDbPath("/database/polymarket.db", VOL), inVol("polymarket.db"));
});

test("resolveDbPath: ruta ya dentro del volumen no cambia", () => {
  assert.equal(resolveDbPath("/data/polymarket.db", VOL), "/data/polymarket.db");
  assert.equal(resolveDbPath("/data/sub/polymarket.db", "/data/"), "/data/sub/polymarket.db");
});
