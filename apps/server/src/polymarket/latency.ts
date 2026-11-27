import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import https from "node:https";
import { ClobH2 } from "./clobConnection.js";
import type { LatencyProbe, LatencyProbeId, LatencySample, UpstreamState } from "@updown/protocol";

/**
 * Latencia hacia el CLOB de Polymarket. NUNCA opera: el servidor no tiene private key y no puede firmar una orden.
 * Todo (salvo `connect`) va por una conexion HTTP/2 persistente y caliente (`ClobH2`), como la de un bot que opera.
 * Una orden real es firma local (EIP-712, ~ms) + POST /order con cabeceras L2. El precio no es un campo: va implicito en
 * makerAmount/takerAmount y clob-client solo pide GET /book si no se le pasa (aqui el libro ya llega por WS), por eso `book` es informativo.
 * La sonda `order` envia una orden COMPLETA (maker = proxy wallet, token del market en curso, 1 USDC, FOK) con FIRMA DE CEROS:
 * Polymarket valida autenticacion, estructura, maker, token y monto y la rechaza al verificar la firma
 * (400 "invalid POLY_PROXY signature"), justo antes del matching. La firma es la barrera: nunca se puede ejecutar.
 * Sin proxy wallet (PM_FUNDER_ADDRESS) o sin market, envia `{}` (se rechaza antes, en la validacion).
 */

export interface ClobCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
  /** EOA que creo la API key (POLY_ADDRESS, `signer` de la orden) */
  address: string;
  /** proxy wallet de la cuenta (`maker` de la orden: donde estan los fondos) */
  funder: string;
}

export interface LatencyOptions {
  clobUrl: string;
  creds: ClobCreds;
  intervalMs: number;
  historyMax: number;
  timeoutMs?: number;
  /** cada cuanto se envia un PING de HTTP/2 para mantener la conexion caliente */
  keepAliveMs?: number;
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;

/** Cuerpo de la sonda `order` cuando no se puede armar la orden completa: Polymarket solo puede rechazarlo. */
export const PROBE_ORDER_BODY = "{}";

/** Firma EIP-712 de la orden de prueba: 65 bytes a cero. No corresponde a ninguna clave: la orden NUNCA puede pasar la verificacion. */
export const PROBE_SIGNATURE = "0x" + "0".repeat(130);
const ZERO32 = "0x" + "0".repeat(64);
/** POLY_PROXY (cuenta de email/Magic con proxy wallet) */
const SIGNATURE_TYPE_PROXY = 1;

export interface ProbeOrderInput {
  tokenId: string;
  /** proxy wallet (maker) */
  maker: string;
  /** EOA firmante */
  signer: string;
  /** API key (owner) */
  owner: string;
  nowMs: number;
  salt: number;
}

/**
 * Orden de compra FOK de 1 USDC a precio limite 0.01 (100 shares) con firma de ceros, en el formato exacto de POST /order.
 * Es realista en todo salvo la firma, que es lo que la hace fallar siempre. El precio NO es una barrera (al final de un market
 * el lado perdedor puede tener asks a 0.01): la barrera es la firma.
 */
export function buildProbeOrder(i: ProbeOrderInput): string {
  return JSON.stringify({
    deferExec: false,
    order: {
      builder: ZERO32,
      expiration: "0",
      maker: i.maker,
      makerAmount: "1000000",
      metadata: ZERO32,
      salt: i.salt,
      side: "BUY",
      signature: PROBE_SIGNATURE,
      signatureType: SIGNATURE_TYPE_PROXY,
      signer: i.signer,
      takerAmount: "100000000",
      timestamp: String(i.nowMs),
      tokenId: i.tokenId,
    },
    orderType: "FOK",
    owner: i.owner,
  });
}

/** Mensaje de error de una respuesta del CLOB (`error` o `errorMsg`), recortado */
export function responseDetail(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: unknown; errorMsg?: unknown };
    const m = j.error ?? j.errorMsg;
    return typeof m === "string" && m ? m.slice(0, 160) : undefined;
  } catch {
    return body ? body.slice(0, 160) : undefined;
  }
}

/**
 * Estimacion de lo que tardaria una orden con la conexion caliente: preparacion (cuerpo + HMAC) + POST /order
 * (o auth, o ping si fallan). Precio desde el libro por WS; sin la firma EIP-712 real (~ms) ni el matching.
 */
export function estimateOrderMs(p: Record<LatencyProbeId, LatencyProbe>, prepMs: number | null = null): number | null {
  const send = p.order.ms ?? p.auth.ms ?? p.ping.ms;
  return send === null ? null : round1(send + (prepMs ?? 0));
}

/** Firma L2 del CLOB: HMAC-SHA256(base64(secret), timestamp + metodo + ruta [+ cuerpo]) en base64 url-safe. */
export function l2Signature(secret: string, timestamp: string, method: string, path: string, body = ""): string {
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(timestamp + method + path + body)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function l2Headers(c: ClobCreds, method: string, path: string, body = "", nowMs = Date.now()): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    POLY_ADDRESS: c.address,
    POLY_SIGNATURE: l2Signature(c.secret, ts, method, path, body),
    POLY_TIMESTAMP: ts,
    POLY_API_KEY: c.apiKey,
    POLY_PASSPHRASE: c.passphrase,
  };
}

interface LatencyEvents {
  sample: [LatencySample];
  state: [UpstreamState];
}

const fail = (error: string): LatencyProbe => ({ ms: null, status: null, error });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LatencyMonitor extends EventEmitter<LatencyEvents> {
  readonly history: LatencySample[] = [];
  state: UpstreamState = "connecting";
  private timer: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private running = false;
  /** conexion HTTP/2 persistente y siempre caliente (como la de un bot que opera): ping, book, auth y order la usan */
  private readonly h2: ClobH2;
  private readonly base: string;
  private readonly timeoutMs: number;
  /** salvaguarda: si Polymarket aceptara alguna vez la orden de prueba (imposible sin firma valida), la sonda se apaga para siempre */
  private orderDisabled = false;

  constructor(
    private readonly opts: LatencyOptions,
    /** token del market en curso (Up); null si aun no se conoce */
    private readonly token: () => string | null,
    /** reloj de Binance */
    private readonly now: () => number,
  ) {
    super();
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.base = opts.clobUrl.replace(/\/$/, "");
    this.h2 = new ClobH2(new URL(this.base).origin, this.timeoutMs);
  }

  get authReady(): boolean {
    const c = this.opts.creds;
    return Boolean(c.apiKey && c.secret && c.passphrase && c.address);
  }

  get reconnects(): number {
    return this.h2.reconnects;
  }

  start(): void {
    // la conexion se abre ya y se mantiene viva con PINGs, asi ninguna orden paga el handshake
    void this.h2.ensure().catch(() => {});
    this.keepAlive = setInterval(() => void this.h2.ping().catch(() => {}), this.opts.keepAliveMs ?? 5000);
    void this.round();
    this.timer = setInterval(() => void this.round(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.timer = this.keepAlive = null;
    this.h2.close();
  }

  /** Una ronda: peticiones en serie para que no compitan entre si. */
  async round(): Promise<LatencySample | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const time = this.now();
      const connect = await this.cold(`${this.base}/time`);
      const edge = await this.h2
        .ping()
        .then((ms): LatencyProbe => ({ ms: round1(ms), status: null }))
        .catch((e) => fail(errMsg(e)));
      const ping = await this.call("GET", "/time");
      const tok = this.token();
      const book = tok ? await this.call("GET", `/book?token_id=${tok}`) : fail("sin market en curso");
      const c = this.opts.creds;
      const creds = Boolean(c.apiKey && c.secret && c.passphrase);
      const auth = creds
        ? await this.call("GET", "/balance-allowance?asset_type=COLLATERAL&signature_type=1", l2Headers(c, "GET", "/balance-allowance"))
        : fail("sin credenciales CLOB");
      let prepMs: number | null = null;
      let order: LatencyProbe;
      if (!creds) order = fail("sin credenciales CLOB");
      else if (this.orderDisabled) order = fail("sonda desactivada");
      else {
        // preparacion = lo que haria el bot al decidir: armar el cuerpo y firmar la peticion (HMAC). La firma EIP-712 real no se hace.
        const t0 = performance.now();
        const body =
          tok && c.funder && c.address
            ? buildProbeOrder({ tokenId: tok, maker: c.funder, signer: c.address, owner: c.apiKey, nowMs: Date.now(), salt: Math.floor(Math.random() * 1e12) })
            : PROBE_ORDER_BODY;
        const headers = { ...l2Headers(c, "POST", "/order", body), "content-type": "application/json" };
        prepMs = Math.round((performance.now() - t0) * 1000) / 1000;
        order = await this.call("POST", "/order", headers, body);
        if (order.status !== null && order.status < 300) {
          this.orderDisabled = true;
          console.error(`[latency] !!! Polymarket respondio ${order.status} a la orden de prueba (${order.detail ?? ""}). Sonda order DESACTIVADA. Revisar de inmediato.`);
        }
      }
      const probes = { connect, edge, ping, book, auth, order };
      const sample: LatencySample = { time, probes, prepMs, estimateMs: estimateOrderMs(probes, prepMs) };
      this.history.push(sample);
      if (this.history.length > this.opts.historyMax) this.history.shift();
      this.setState(ping.ms !== null ? "connected" : "reconnecting");
      this.emit("sample", sample);
      return sample;
    } finally {
      this.running = false;
    }
  }

  private setState(s: UpstreamState) {
    if (s === this.state) return;
    this.state = s;
    this.emit("state", s);
  }

  /** Peticion por la conexion HTTP/2 caliente. `detail` solo en errores y en POST (la respuesta de Polymarket a la orden). */
  private async call(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<LatencyProbe> {
    try {
      const r = await this.h2.request(method, path, headers, body);
      const detail = r.status >= 300 || method === "POST" ? responseDetail(r.text) : undefined;
      return detail ? { ms: round1(r.ms), status: r.status, detail } : { ms: round1(r.ms), status: r.status };
    } catch (e) {
      return fail(errMsg(e));
    }
  }

  /** GET por una conexion nueva (HTTP/1.1, sin reutilizar nada): coste de DNS + TCP + TLS + ida y vuelta. Solo diagnostico. */
  private cold(url: string): Promise<LatencyProbe> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const req = https.get(url, { agent: false, timeout: this.timeoutMs }, (res) => {
        res.resume();
        res.on("end", () => resolve({ ms: round1(performance.now() - t0), status: res.statusCode ?? null }));
        res.on("error", (e) => resolve(fail(e.message)));
      });
      req.on("timeout", () => req.destroy(new Error(`timeout ${this.timeoutMs} ms`)));
      req.on("error", (e) => resolve(fail(e.message)));
    });
  }
}
