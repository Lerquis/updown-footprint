# 0012 — Conexión HTTP/2 persistente y caliente al CLOB de Polymarket

- **Estado**: aceptada · 2026-11-26

## Contexto
Queremos saber cuánto tardaría una orden enviada desde el servidor ([latency](../features/latency.md)) y dejar preparado el camino más rápido para cuando se opere. Medido desde Costa Rica (2026-11-26):
- **Conexión nueva:** DNS ~5 ms + TCP ~78 ms + TLS ~80 ms + respuesta ~200 ms = 350–570 ms.
- **HTTP/1.1 con keep-alive:** 195–209 ms.
- **HTTP/2 con la conexión abierta:** ~190 ms, muy estable.
- **PING de HTTP/2:** ~76 ms. Responde Cloudflare Miami (`cf-ray …-MIA`). El resto, ~120 ms, es Cloudflare ↔ servidores de Polymarket + validación: el origen está lejos de Miami.
- **Preparar la orden** (cuerpo + HMAC): ~0.1 ms.

## Decisión
- Todo lo que va al CLOB (y en el futuro las órdenes) usa **una sola conexión HTTP/2** (`ClobH2`, `polymarket/clobConnection.ts`):
  - se abre al arrancar;
  - se reabre en cuanto se cae;
  - se mantiene viva con un PING de HTTP/2 cada `PM_LATENCY_KEEPALIVE_MS` (5 s).
- Ninguna orden paga el handshake.
- El precio sale del libro que ya llega por WebSocket. No hay `GET /book` antes de la orden.
- La conexión nueva (`connect`) se sigue midiendo solo como diagnóstico.
- La región desde donde mide el servidor (`RAILWAY_REPLICA_REGION` o `local`) se publica en el snapshot. Así se comparan local y Railway.

## Consecuencias
- La orden pasa de ~222 a ~202 ms en local (~10 %) y casi sin variación entre medidas.
- El tiempo restante es distancia, no código. Lo que más puede bajarlo es la **región del servidor**: Railway está en Europe West (Amsterdam).
- `connect` y `edge` quedan como diagnóstico: separan red, Polymarket y coste de reconexión.
