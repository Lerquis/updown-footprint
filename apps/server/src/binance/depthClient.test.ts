import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgesDiff, isStaleDiff } from "./depthClient.js";

test("spot: primer diff cubre lastUpdateId + 1 y los siguientes van seguidos (U == u anterior + 1)", () => {
  assert.equal(bridgesDiff("spot", { U: 95, u: 105 }, 0, 100), true);
  assert.equal(bridgesDiff("spot", { U: 102, u: 105 }, 0, 100), false); // hueco tras el snapshot
  assert.equal(bridgesDiff("spot", { U: 106, u: 110 }, 105, 100), true);
  assert.equal(bridgesDiff("spot", { U: 107, u: 110 }, 105, 100), false);
  assert.equal(isStaleDiff("spot", { u: 100 }, 100), true);
  assert.equal(isStaleDiff("spot", { u: 101 }, 100), false);
});

test("futures: primer diff con U <= lastUpdateId <= u y los siguientes encadenados por pu", () => {
  assert.equal(bridgesDiff("futures", { U: 95, u: 100 }, 0, 100), true);
  assert.equal(bridgesDiff("futures", { U: 101, u: 105 }, 0, 100), false);
  // en futuros U NO es u anterior + 1: manda pu
  assert.equal(bridgesDiff("futures", { U: 120, u: 130, pu: 105 }, 105, 100), true);
  assert.equal(bridgesDiff("futures", { U: 106, u: 130, pu: 104 }, 105, 100), false);
  assert.equal(isStaleDiff("futures", { u: 99 }, 100), true);
  assert.equal(isStaleDiff("futures", { u: 100 }, 100), false);
});
