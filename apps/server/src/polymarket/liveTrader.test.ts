import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PmMarket } from "@updown/protocol";
import { evaluateFill, limitPriceFor, LiveTrader, parseClobAmount, realBuyUsd, type LiveTraderConfig } from "./liveTrader.js";

const SIZE = { scale: 0.2, minUsd: 1, maxUsd: 10, minShares: 5 };

test("limitPriceFor: compra = senal + 2c redondeado arriba; venta = senal - 2c redondeado abajo; dentro de [0.01, 0.99]", () => {
  assert.equal(limitPriceFor("buy", 0.6, 0.02, 0.01), 0.62);
  assert.equal(limitPriceFor("buy", 0.605, 0.02, 0.01), 0.63);
  assert.equal(limitPriceFor("sell", 0.7, 0.02, 0.01), 0.68);
  assert.equal(limitPriceFor("sell", 0.705, 0.02, 0.01), 0.68);
  assert.equal(limitPriceFor("buy", 0.98, 0.02, 0.01), 0.99);
  assert.equal(limitPriceFor("sell", 0.02, 0.02, 0.01), 0.01);
  // sin errores de coma flotante (0.29 + 0.02 = 0.31, no 0.32)
  assert.equal(limitPriceFor("buy", 0.29, 0.02, 0.01), 0.31);
});

test("realBuyUsd: paper / 5 entre 1 y 10 USDC", () => {
  assert.equal(realBuyUsd(5, 0.1, SIZE, 40), 1);
  assert.equal(realBuyUsd(20, 0.1, SIZE, 40), 4);
  assert.equal(realBuyUsd(50, 0.1, SIZE, 40), 10);
  assert.equal(realBuyUsd(80, 0.1, SIZE, 40), 10);
});

test("realBuyUsd: se sube al minimo de Polymarket (5 tokens al precio limite) para poder venderlo", () => {
  // paper 5 -> 1 USDC, pero 5 tokens a 0.62 = 3.10 USDC
  assert.equal(realBuyUsd(5, 0.62, SIZE, 40), 3.1);
});

test("realBuyUsd: respeta el tope por market y devuelve null si no llega al minimo", () => {
  assert.equal(realBuyUsd(50, 0.1, SIZE, 3), 3);
  assert.equal(realBuyUsd(50, 0.62, SIZE, 3), null); // haria falta 3.10
  assert.equal(realBuyUsd(5, 0.1, SIZE, 0), null);
});

test("parseClobAmount: decimales o enteros de 6 decimales", () => {
  assert.equal(parseClobAmount("4.98"), 4.98);
  assert.equal(parseClobAmount("4980000"), 4.98);
  assert.equal(parseClobAmount("8"), 8);
  assert.equal(parseClobAmount(""), 0);
  assert.equal(parseClobAmount(undefined), 0);
});

test("evaluateFill: compra casada -> tokens, USDC, precio medio y deslizamiento", () => {
  const f = evaluateFill("buy", 0.6, 200, { success: true, status: "matched", makingAmount: "3.05", takingAmount: "5", orderID: "0xabc" });
  assert.equal(f.status, "matched");
  assert.equal(f.filledShares, 5);
  assert.equal(f.filledUsd, 3.05);
  assert.equal(f.avgPrice, 0.61);
  assert.equal(f.slippage, 0.01); // pago 1c peor que la senal
  assert.equal(f.orderId, "0xabc");
});

test("evaluateFill: venta casada -> el deslizamiento es positivo si se cobra menos que la senal", () => {
  const f = evaluateFill("sell", 0.7, 200, { success: true, status: "matched", makingAmount: "5", takingAmount: "3.45" });
  assert.equal(f.avgPrice, 0.69);
  assert.equal(f.slippage, 0.01);
});

test("evaluateFill: sin liquidez dentro del limite o rechazada", () => {
  assert.equal(evaluateFill("buy", 0.6, 200, { success: true, status: "unmatched", makingAmount: "0", takingAmount: "0" }).status, "unmatched");
  const r = evaluateFill("buy", 0.6, 400, { error: "not enough balance / allowance" });
  assert.equal(r.status, "rejected");
  assert.equal(r.detail, "not enough balance / allowance");
  assert.equal(evaluateFill("buy", 0.6, 200, { success: false, errorMsg: "FAK no match" }).status, "rejected");
});

// ── Interruptor ──
const key = generatePrivateKey();
const addr = privateKeyToAccount(key).address;
const cfg = (over: Partial<LiveTraderConfig> = {}): LiveTraderConfig => ({
  clobUrl: "https://clob.example",
  creds: { apiKey: "k", secret: "c2VjcmV0", passphrase: "p", address: addr, funder: "0xfund" },
  privateKey: key,
  password: "testing",
  ...SIZE,
  maxMarketUsd: 40,
  slippage: 0.02,
  tick: 0.01,
  timeoutMs: 1000,
  ...over,
});
const market = (slug: string): PmMarket => ({
  slug,
  title: slug,
  start: 0,
  end: 300_000,
  upToken: "u",
  downToken: "d",
  priceToBeat: null,
  closePrice: null,
  changePct: null,
  status: "live",
  result: null,
});

test("LiveTrader: sin clave privada o sin contrasena queda desactivado y no se puede activar", () => {
  const a = new LiveTrader(cfg({ privateKey: "" }), () => 0);
  assert.equal(a.enabled, false);
  assert.match(a.disabledReason!, /PM_WALLET_PRIVATE_KEY/);
  a.onMarket(market("m1"));
  assert.match(a.setArmed("m1", true)!, /desactivadas/);
  const b = new LiveTrader(cfg({ password: "" }), () => 0);
  assert.match(b.disabledReason!, /TRADING_PASSWORD/);
});

test("LiveTrader: una clave que no es la del firmante desactiva todo", () => {
  const t = new LiveTrader(cfg({ privateKey: generatePrivateKey() }), () => 0);
  assert.equal(t.enabled, false);
  assert.match(t.disabledReason!, /no de PM_SIGNER_ADDRESS/);
});

test("LiveTrader: contrasena", () => {
  const t = new LiveTrader(cfg(), () => 0);
  assert.equal(t.checkPassword("testing"), true);
  assert.equal(t.checkPassword("Testing"), false);
  assert.equal(t.checkPassword(undefined), false);
});

test("LiveTrader: solo se activa en el market en curso y se apaga solo al cambiar de market", () => {
  const t = new LiveTrader(cfg(), () => 0);
  assert.equal(t.enabled, true);
  t.onMarket(market("m1"));
  assert.match(t.setArmed("m0", true)!, /market en curso/);
  assert.equal(t.setArmed("m1", true), null);
  assert.equal(t.state().armedSlug, "m1");
  t.onMarket(market("m2"));
  assert.equal(t.state().armedSlug, null);
  assert.equal(t.state().currentSlug, "m2");
});

test("LiveTrader: apagado ignora las senales (no firma ni envia nada)", async () => {
  const t = new LiveTrader(cfg(), () => 0);
  t.onMarket(market("m1"));
  let trades = 0;
  t.on("trade", () => trades++);
  t.onSignals([{ id: "s1", slug: "m1", time: 1, action: "buy", side: "up", reason: "entry", price: 0.5, fee: 0, shares: 10, amount: 5, pSide: 0.6, edge: 0.05, tau: 200 }], market("m1"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(trades, 0);
});

test("LiveTrader: venta sin tokens reales se registra como omitida, sin enviar", async () => {
  const t = new LiveTrader(cfg(), () => 0);
  t.onMarket(market("m1"));
  t.setArmed("m1", true);
  const got = new Promise<import("@updown/protocol").LiveTrade>((r) => t.once("trade", r));
  t.onSignals([{ id: "s2", slug: "m1", time: 1, action: "sell", side: "up", reason: "exit", price: 0.7, fee: 0, shares: 10, amount: 7, pSide: 0.4, edge: 0.03, tau: 100 }], market("m1"));
  const tr = await got;
  assert.equal(tr.status, "skipped");
  assert.equal(tr.sentAt, null);
  assert.match(tr.detail!, /sin tokens/);
});
