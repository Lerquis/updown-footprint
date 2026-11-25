import type { WebSocket } from "ws";

/**
 * Canal WS generico: al conectar un cliente le envia `snapshot()` y despues todo lo que se `broadcast`.
 * Cada tipo de dato es una instancia con su propia ruta (ver CHANNELS en @updown/protocol).
 */
export class Channel<M> {
  private clients = new Set<WebSocket>();

  constructor(private readonly snapshot: () => M) {}

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    ws.send(JSON.stringify(this.snapshot()));
  }

  broadcast(msg: M): void {
    if (!this.clients.size) return;
    const payload = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(payload);
  }

  get size(): number {
    return this.clients.size;
  }
}
