import { EventEmitter } from "node:events";
import { ChainId, OrderBuilder, type ApprovalStep } from "@predictdotfun/sdk";
import { Wallet } from "ethers";
import type { UpstreamState } from "@updown/protocol";
import { ClobH2 } from "../polymarket/clobConnection.js";
import { PredictWs } from "./wsClient.js";

/**
 * Cuenta de Predict.fun con la que se opera de verdad (comun a las fuentes). Ver docs/features/predict-markets.md#compras-reales.
 *  - Firma con `@predictdotfun/sdk` (EIP-712): wallet propia (EOA, `PREDICT_PRIVATE_KEY`) o cuenta de Predict (la smart wallet
 *    que crea la web, `PREDICT_ACCOUNT`, firmada por la wallet de Privy cuya clave es `PREDICT_PRIVATE_KEY`).
 *  - JWT (24 h) para crear ordenes y para el topic `predictWalletEvents/{jwt}` (ejecuciones). El login firma el mensaje de
 *    Predict, que incluye ACEPTAR SUS TERMINOS: solo se hace cuando el usuario activa las compras (`ensureLogin`), nunca al arrancar.
 *  - Conexion HTTP/2 caliente a la API (como la del CLOB de Polymarket, ADR 0012).
 *  - Al arrancar solo LEE de la cadena (RPC publico del SDK): dueño de la cuenta, aprobaciones para operar y saldo USDT.
 *    Nunca envia transacciones: las aprobaciones las hace el usuario (`npm run predict:approvals`).
 */

export interface PredictAccountConfig {
  restUrl: string;
  wsUrl: string;
  apiKey: string;
  /** clave privada: la de la EOA, o la de la wallet de Privy si se usa una cuenta de Predict */
  privateKey: string;
  /** direccion de la cuenta de Predict (portfolio de predict.fun); vacia = se opera con la EOA */
  predictAccount: string;
  timeoutMs?: number;
}

export interface PredictCall {
  status: number;
  text: string;
  /** ida y vuelta (ms) */
  ms: number;
}

/** Mensaje de error de la API de Predict: `error` (codigo estable) + `message` */
export function predictError(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    const parts = [j.error, j.message].filter((x): x is string => typeof x === "string" && x.length > 0);
    return parts.length ? parts.join(": ").slice(0, 200) : undefined;
  } catch {
    return text ? text.slice(0, 200) : undefined;
  }
}

interface AccountEvents {
  /** evento de una orden de la wallet (orderAccepted, orderTransactionSuccess, ...) */
  wallet: [Record<string, unknown>];
  /** cambio de estado (login, aprobaciones, saldo, canal de la wallet) */
  state: [];
}

const JWT_MS = 23 * 3600_000; // valido 24 h: se renueva una hora antes

export class PredictAccount extends EventEmitter<AccountEvents> {
  builder: OrderBuilder | null = null;
  /** direccion que firma y opera (la cuenta de Predict o la EOA); null hasta `init` */
  address: string | null = null;
  disabledReason: string | null;
  /** aprobaciones de compra/venta en markets estandar: null = sin comprobar */
  approvals: { ok: boolean; missing: string[] } | null = null;
  /** saldo USDT de la cuenta (se refresca cada minuto); null sin leer */
  balanceUsd: number | null = null;
  private jwt: string | null = null;
  private jwtAt = 0;
  private logging: Promise<string> | null = null;
  private readonly h2: ClobH2;
  private readonly events: PredictWs;
  private walletTopic: string | null = null;
  private eventsStarted = false;
  private keepAlive: NodeJS.Timeout | null = null;
  private balanceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly c: PredictAccountConfig) {
    super();
    const missing = [!c.apiKey && "PREDICT_API_KEY", !c.privateKey.trim() && "PREDICT_PRIVATE_KEY"].filter(Boolean);
    this.disabledReason = missing.length ? `falta ${missing.join(", ")}` : null;
    this.h2 = new ClobH2(new URL(c.restUrl).origin, c.timeoutMs ?? 5000);
    this.events = new PredictWs("predict-wallet", c.wsUrl, null);
    this.events.on("wallet", (ev) => this.emit("wallet", ev));
    this.events.on("state", () => this.emit("state"));
    // JWT rechazado (caducado o revocado): se vuelve a pedir en la siguiente orden
    this.events.on("rejected", ({ topic }) => {
      if (topic === this.walletTopic) {
        this.jwt = null;
        this.emit("state");
      }
    });
  }

  get enabled(): boolean {
    return this.disabledReason === null && this.builder !== null;
  }

  /** canal de eventos de la wallet */
  get walletStream(): UpstreamState {
    return this.walletTopic ? this.events.state : "connecting";
  }

  get loggedIn(): boolean {
    return this.jwt !== null && Date.now() - this.jwtAt < JWT_MS;
  }

  /** Prepara el firmante y lee de la cadena (dueño de la cuenta, aprobaciones, saldo). No envia nada. */
  async init(): Promise<void> {
    this.h2.ensure().catch(() => {});
    this.keepAlive = setInterval(() => void this.h2.ping().catch(() => {}), 5000);
    if (this.disabledReason) return;
    try {
      const k = this.c.privateKey.trim();
      const wallet = new Wallet(k.startsWith("0x") ? k : `0x${k}`);
      const acct = this.c.predictAccount.trim();
      // con cuenta de Predict, el SDK comprueba on-chain que la wallet de Privy es su dueña
      this.builder = acct ? await OrderBuilder.make(ChainId.BnbMainnet, wallet, { predictAccount: acct }) : await OrderBuilder.make(ChainId.BnbMainnet, wallet);
      this.address = acct || wallet.address;
      console.log(`[predict-live] firmante listo: ${acct ? `cuenta de Predict ${acct}` : `EOA ${wallet.address}`}`);
    } catch (e) {
      this.disabledReason = `no se pudo preparar la firma: ${e instanceof Error ? e.message : e}`;
      console.error(`[predict-live] ${this.disabledReason}`);
      this.emit("state");
      return;
    }
    await this.checkApprovals();
    await this.refreshBalance();
    this.balanceTimer = setInterval(() => void this.refreshBalance(), 60_000);
    this.emit("state");
  }

  /** Aprobaciones para comprar y vender en markets estandar (los up/down de 5 min). Solo lectura. */
  async checkApprovals(): Promise<void> {
    if (!this.builder) return;
    try {
      const steps: ApprovalStep[] = this.builder.getApprovalSteps({ operation: "TRADE", isNegRisk: false, isYieldBearing: false });
      const checks = await this.builder.checkApprovals(steps);
      const missing = checks.filter((x) => !x.satisfied).map((x) => x.step.label);
      this.approvals = { ok: missing.length === 0, missing };
      if (missing.length) console.warn(`[predict-live] faltan aprobaciones: ${missing.join(", ")} (npm run predict:approvals -w @updown/server)`);
    } catch (e) {
      console.warn(`[predict-live] no se pudieron comprobar las aprobaciones: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async refreshBalance(): Promise<void> {
    if (!this.builder || !this.address) return;
    try {
      const wei = await this.builder.balanceOf("USDT", this.address);
      const usd = Number(wei / 10n ** 14n) / 1e4;
      if (usd !== this.balanceUsd) {
        this.balanceUsd = usd;
        this.emit("state");
      }
    } catch {
      // RPC publico ocupado: se reintenta en la siguiente vuelta
    }
  }

  stop(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    this.events.stop();
    this.h2.close();
  }

  /** Peticion a la API por la conexion caliente, con la API key (y el JWT si `auth`) */
  async request(method: string, path: string, body?: string, auth = false): Promise<PredictCall> {
    const headers: Record<string, string> = { "x-api-key": this.c.apiKey };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && this.loggedIn) headers.authorization = `Bearer ${this.jwt}`;
    const r = await this.h2.request(method, path, headers, body);
    return { status: r.status, text: r.text, ms: r.ms };
  }

  /** PING de HTTP/2 (red pura hasta el borde de Cloudflare) */
  ping(): Promise<number> {
    return this.h2.ping();
  }

  /**
   * JWT valido (lo pide si falta o va a caducar) y suscripcion a los eventos de la wallet. Firmar el mensaje de login acepta los
   * terminos de Predict: se llama solo al activar las compras reales (o con una orden en curso).
   */
  async ensureLogin(): Promise<string> {
    if (this.loggedIn) return this.jwt!;
    if (!this.builder || !this.address) throw new Error(this.disabledReason ?? "firmante no preparado");
    this.logging ??= this.login().finally(() => (this.logging = null));
    return this.logging;
  }

  private async login(): Promise<string> {
    const b = this.builder!;
    const msg = await this.request("GET", "/v1/auth/message");
    if (msg.status !== 200) throw new Error(`login: ${predictError(msg.text) ?? `HTTP ${msg.status}`}`);
    const message = (JSON.parse(msg.text) as { data?: { message?: string } }).data?.message;
    if (!message) throw new Error("login: mensaje vacio");
    const signature = this.c.predictAccount.trim() ? await b.signPredictAccountMessage(message) : await this.signEoa(message);
    const r = await this.request("POST", "/v1/auth", JSON.stringify({ signer: this.address, message, signature }));
    const token = r.status < 300 ? (JSON.parse(r.text) as { data?: { token?: string } }).data?.token : undefined;
    if (!token) throw new Error(`login: ${predictError(r.text) ?? `HTTP ${r.status}`}`);
    this.jwt = token;
    this.jwtAt = Date.now();
    // eventos de la wallet con el JWT nuevo
    if (this.walletTopic) this.events.unsubscribe(this.walletTopic);
    this.walletTopic = `predictWalletEvents/${token}`;
    this.events.subscribe(this.walletTopic);
    if (!this.eventsStarted) {
      this.eventsStarted = true;
      this.events.start();
    }
    console.log(`[predict-live] sesion iniciada para ${this.address}`);
    this.emit("state");
    return token;
  }

  private async signEoa(message: string): Promise<string> {
    const k = this.c.privateKey.trim();
    return new Wallet(k.startsWith("0x") ? k : `0x${k}`).signMessage(message);
  }
}
