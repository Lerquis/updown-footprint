import { EventEmitter } from "node:events";
import https from "node:https";
import type { LatencyProbe, LatencySample, UpstreamState } from "@updown/protocol";
import { estimateOrderMs } from "../polymarket/latency.js";
import { predictError, type PredictAccount } from "./account.js";

/**
 * Latencia a la API de ordenes de Predict.fun cada `intervalMs`. NUNCA opera. Mismas sondas que la de Polymarket (canal
 * `/ws/predict-latency`, `LatencySample`) sobre la conexion HTTP/2 caliente de la cuenta:
 *  - connect: GET /v1/auth/message por una conexion nueva (DNS + TCP + TLS + ida y vuelta);
 *  - edge: PING de HTTP/2 (borde de Cloudflare);
 *  - ping: GET /v1/auth/message por la conexion caliente;
 *  - book: GET /v1/markets/{id}/orderbook del market en curso (informativo: los motores tienen el libro por WS);
 *  - auth: GET /v1/orders?first=1 con el JWT (sin sesion iniciada responde 401: sigue midiendo el gateway);
 *  - order: POST /v1/orders con una orden de prueba que NO puede ejecutarse (`buildPredictProbeOrder`).
 */

export interface PredictLatencyOptions {
  restUrl: string;
  apiKey: string;
  intervalMs: number;
  historyMax: number;
  timeoutMs?: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** firma de 65 bytes a cero: no corresponde a ninguna clave, la orden nunca pasa la verificacion */
export const PREDICT_PROBE_SIGNATURE = "0x" + "0".repeat(130);

/**
 * Orden de prueba con TRES barreras, cualquiera la rechaza: firma de ceros (`create_order_contract_invalid_signature`), expiracion
 * a 30 s (`create_order_expiry_too_soon`, el minimo son 2 min) y compra LIMIT post-only a 0,01 (nunca cruzaria el libro).
 * Por lo demas es una orden realista de 1 USDT (100 shares a 0,01) del token Up del market en curso.
 */
export function buildPredictProbeOrder(i: { tokenId: string; maker: string; nowMs: number; salt: number; feeRateBps: number }): string {
  return JSON.stringify({
    data: {
      order: {
        hash: "0x" + "0".repeat(64),
        salt: String(i.salt),
        maker: i.maker,
        signer: i.maker,
        taker: ZERO_ADDRESS,
        tokenId: i.tokenId,
        makerAmount: "1000000000000000000",
        takerAmount: "100000000000000000000",
        expiration: String(Math.floor(i.nowMs / 1000) + 30),
        nonce: "0",
        feeRateBps: String(i.feeRateBps),
        side: 0,
        signatureType: 0,
        signature: PREDICT_PROBE_SIGNATURE,
      },
      pricePerShare: "10000000000000000",
      strategy: "LIMIT",
      isPostOnly: true,
    },
  });
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;
const fail = (error: string): LatencyProbe => ({ ms: null, status: null, error });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PredictLatencyMonitor extends EventEmitter<{ sample: [LatencySample]; state: [UpstreamState] }> {
  readonly history: LatencySample[] = [];
  state: UpstreamState = "connecting";
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** salvaguarda: si Predict aceptara alguna vez la orden de prueba (imposible), la sonda se apaga para siempre */
  private orderDisabled = false;
  private readonly base: string;

  constructor(
    readonly opts: PredictLatencyOptions,
    private readonly account: PredictAccount,
    /** market en curso: id y datos para la orden de prueba; null si aun no se conoce */
    private readonly market: () => { marketId: number; upTokenId: string | null; feeRateBps: number } | null,
    /** reloj de Binance */
    private readonly now: () => number,
  ) {
    super();
    this.base = opts.restUrl.replace(/\/$/, "");
  }

  /** hay sesion (JWT): `auth` y `order` pasan del gateway */
  get authReady(): boolean {
    return this.account.loggedIn;
  }

  start(): void {
    void this.round();
    this.timer = setInterval(() => void this.round(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async round(): Promise<LatencySample | null> {
    if (this.running || !this.opts.apiKey) return null;
    this.running = true;
    try {
      const time = this.now();
      const connect = await this.cold("/v1/auth/message");
      const edge = await this.account
        .ping()
        .then((ms): LatencyProbe => ({ ms: round1(ms), status: null }))
        .catch((e) => fail(errMsg(e)));
      const ping = await this.call("GET", "/v1/auth/message");
      const m = this.market();
      const book = m ? await this.call("GET", `/v1/markets/${m.marketId}/orderbook`) : fail("sin market en curso");
      const auth = await this.call("GET", "/v1/orders?first=1", undefined, true);
      let prepMs: number | null = null;
      let order: LatencyProbe;
      if (this.orderDisabled) order = fail("sonda desactivada");
      else if (!m?.upTokenId) order = fail("sin market en curso");
      else {
        const t0 = performance.now();
        const body = buildPredictProbeOrder({ tokenId: m.upTokenId, maker: this.account.address ?? ZERO_ADDRESS, nowMs: Date.now(), salt: Math.floor(Math.random() * 1e12), feeRateBps: m.feeRateBps });
        prepMs = Math.round((performance.now() - t0) * 1000) / 1000;
        order = await this.call("POST", "/v1/orders", body, true);
        if (order.status !== null && order.status < 300) {
          this.orderDisabled = true;
          console.error(`[predict-latency] !!! Predict respondio ${order.status} a la orden de prueba (${order.detail ?? ""}). Sonda order DESACTIVADA. Revisar de inmediato.`);
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

  private async call(method: string, path: string, body?: string, auth = false): Promise<LatencyProbe> {
    try {
      const r = await this.account.request(method, path, body, auth);
      const detail = r.status >= 300 || method === "POST" ? predictError(r.text) : undefined;
      return detail ? { ms: round1(r.ms), status: r.status, detail } : { ms: round1(r.ms), status: r.status };
    } catch (e) {
      return fail(errMsg(e));
    }
  }

  /** GET por una conexion nueva (HTTP/1.1, sin reutilizar nada): coste de DNS + TCP + TLS + ida y vuelta */
  private cold(path: string): Promise<LatencyProbe> {
    const timeout = this.opts.timeoutMs ?? 5000;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const req = https.get(`${this.base}${path}`, { agent: false, timeout, headers: { "x-api-key": this.opts.apiKey } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ ms: round1(performance.now() - t0), status: res.statusCode ?? null }));
        res.on("error", (e) => resolve(fail(e.message)));
      });
      req.on("timeout", () => req.destroy(new Error(`timeout ${timeout} ms`)));
      req.on("error", (e) => resolve(fail(e.message)));
    });
  }
}
