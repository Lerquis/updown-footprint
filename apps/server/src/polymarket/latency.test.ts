import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { LatencyProbe } from "@updown/protocol";
import { buildProbeOrder, estimateOrderMs, l2Headers, l2Signature, PROBE_ORDER_BODY, PROBE_SIGNATURE, responseDetail } from "./latency.js";

const ok = (ms: number): LatencyProbe => ({ ms, status: 200 });
const fail: LatencyProbe = { ms: null, status: null, error: "x" };

test("estimateOrderMs: POST /order; si falla, auth; si no, ping; el libro (REST) y el borde no cuentan", () => {
  const base = { connect: ok(400), edge: ok(70) };
  assert.equal(estimateOrderMs({ ...base, ping: ok(90), book: ok(100), auth: ok(120), order: ok(150) }), 150);
  assert.equal(estimateOrderMs({ ...base, ping: ok(90), book: ok(100), auth: ok(120), order: fail }), 120);
  assert.equal(estimateOrderMs({ ...base, ping: ok(90), book: fail, auth: fail, order: fail }), 90);
  assert.equal(estimateOrderMs({ ...base, ping: fail, book: ok(100), auth: fail, order: fail }), null);
});

test("estimateOrderMs: suma la preparacion de la orden", () => {
  assert.equal(estimateOrderMs({ connect: ok(400), edge: ok(70), ping: ok(90), book: ok(100), auth: ok(120), order: ok(150) }, 0.25), 150.3);
});

test("la sonda order de respaldo no lleva una orden: cuerpo vacio", () => {
  assert.deepEqual(JSON.parse(PROBE_ORDER_BODY), {});
});

test("buildProbeOrder: orden completa de POST /order con FIRMA DE CEROS (nunca ejecutable)", () => {
  const body = buildProbeOrder({ tokenId: "123", maker: "0xmaker", signer: "0xsigner", owner: "key", nowMs: 1_700_000_000_000, salt: 42 });
  const o = JSON.parse(body);
  // la barrera: firma de 65 bytes a cero, que no corresponde a ninguna clave
  assert.equal(o.order.signature, PROBE_SIGNATURE);
  assert.match(PROBE_SIGNATURE, /^0x0{130}$/);
  // el resto es una orden de mercado real: FOK, compra de 1 USDC, maker = proxy wallet, signer = EOA
  assert.equal(o.orderType, "FOK");
  assert.equal(o.owner, "key");
  assert.equal(o.order.side, "BUY");
  assert.equal(o.order.maker, "0xmaker");
  assert.equal(o.order.signer, "0xsigner");
  assert.equal(o.order.tokenId, "123");
  assert.equal(o.order.makerAmount, "1000000");
  assert.equal(o.order.expiration, "0");
  assert.equal(o.order.signatureType, 1);
  assert.equal(o.order.timestamp, "1700000000000");
});

test("responseDetail: mensaje de error del CLOB", () => {
  assert.equal(responseDetail('{"error":"invalid POLY_PROXY signature"}'), "invalid POLY_PROXY signature");
  assert.equal(responseDetail('{"success":false,"errorMsg":"not enough balance"}'), "not enough balance");
  assert.equal(responseDetail('{"time":1}'), undefined);
  assert.equal(responseDetail("Bad Gateway"), "Bad Gateway");
});

test("l2Signature: HMAC-SHA256 del secreto en base64, salida url-safe", () => {
  const secret = Buffer.from("secreto-de-prueba-0123456789").toString("base64");
  const sig = l2Signature(secret, "1700000000", "GET", "/balance-allowance");
  const raw = createHmac("sha256", Buffer.from(secret, "base64")).update("1700000000GET/balance-allowance").digest("base64");
  assert.equal(sig, raw.replace(/\+/g, "-").replace(/\//g, "_"));
  assert.ok(!/[+/]/.test(sig));
});

test("l2Headers: timestamp en segundos y cabeceras POLY_*", () => {
  const h = l2Headers({ apiKey: "k", secret: "c2VjcmV0", passphrase: "p", address: "0xabc", funder: "0xfund" }, "GET", "/x", "", 1_700_000_000_999);
  assert.equal(h.POLY_TIMESTAMP, "1700000000");
  assert.equal(h.POLY_ADDRESS, "0xabc");
  assert.equal(h.POLY_API_KEY, "k");
  assert.equal(h.POLY_PASSPHRASE, "p");
  assert.equal(h.POLY_SIGNATURE, l2Signature("c2VjcmV0", "1700000000", "GET", "/x"));
});
