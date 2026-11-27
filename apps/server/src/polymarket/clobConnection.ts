import http2 from "node:http2";

export interface H2Response {
  /** ida y vuelta: del envio de la peticion al ultimo byte de la respuesta */
  ms: number;
  status: number;
  text: string;
}

/**
 * Conexion HTTP/2 persistente al CLOB (una sola conexion TLS, siempre abierta): lo que usaria un bot para enviar ordenes.
 * - Se abre al arrancar y se reabre en cuanto se cae, para que ninguna peticion pague DNS + TCP + TLS.
 * - `ping()` envia un PING de HTTP/2: lo responde el borde de Cloudflare, asi que mide la red hasta el borde (sin Polymarket)
 *   y de paso mantiene viva la conexion.
 * Medido desde Costa Rica: HTTP/2 caliente ~190 ms estables frente a 195-209 ms de HTTP/1.1 keep-alive.
 */
export class ClobH2 {
  private session: http2.ClientHttp2Session | null = null;
  private connecting: Promise<http2.ClientHttp2Session> | null = null;
  private closed = false;
  private everConnected = false;
  /** veces que se reabrio la conexion (deberia quedarse en 0-1 si se mantiene caliente) */
  reconnects = 0;

  constructor(
    private readonly origin: string,
    private readonly timeoutMs = 5000,
  ) {}

  /** Abre la conexion si no lo esta (fuera de la medida de cada peticion). */
  ensure(): Promise<http2.ClientHttp2Session> {
    if (this.session && !this.session.closed && !this.session.destroyed) return Promise.resolve(this.session);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = http2.connect(this.origin);
      const fail = (e: Error) => {
        this.connecting = null;
        reject(e);
      };
      s.once("error", fail);
      s.once("connect", () => {
        s.off("error", fail);
        s.on("error", () => {}); // los errores cierran la sesion; se reabre en el siguiente uso
        s.once("close", () => {
          if (this.session === s) this.session = null;
          // reabrir enseguida: la siguiente orden no debe pagar el handshake
          if (!this.closed) setTimeout(() => void this.ensure().catch(() => {}), 100).unref();
        });
        if (this.everConnected) this.reconnects++;
        this.everConnected = true;
        this.session = s;
        this.connecting = null;
        resolve(s);
      });
    });
    return this.connecting;
  }

  async request(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<H2Response> {
    const s = await this.ensure();
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const req = s.request({ ":method": method, ":path": path, ...headers }, { endStream: body === undefined });
      let status = 0;
      let text = "";
      req.setEncoding("utf8");
      req.setTimeout(this.timeoutMs, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (h) => (status = Number(h[":status"]) || 0));
      req.on("data", (d: string) => {
        if (text.length < 2048) text += d;
      });
      req.on("end", () => resolve({ ms: performance.now() - t0, status, text }));
      req.on("close", () => {
        if (!status) reject(new Error(`stream cerrado sin respuesta (timeout ${this.timeoutMs} ms o conexion caida)`));
      });
      req.on("error", reject);
      if (body !== undefined) req.end(body);
    });
  }

  /** PING de HTTP/2: ida y vuelta hasta el borde de Cloudflare (ms). */
  async ping(): Promise<number> {
    const s = await this.ensure();
    return new Promise((resolve, reject) => {
      const ok = s.ping((err, duration) => (err ? reject(err) : resolve(duration)));
      if (!ok) reject(new Error("ping no enviado"));
    });
  }

  close(): void {
    this.closed = true;
    this.session?.close();
    this.session = null;
  }
}
