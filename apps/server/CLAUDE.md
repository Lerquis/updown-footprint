# apps/server

Node (ESM) + TypeScript + `ws`. Corre con `tsx` (dev y prod) porque `@updown/protocol` se consume como TS fuente.

## Estructura
- `src/index.ts` — composición: HTTP (`/health`), enrutado de `upgrade` por path, wiring upstream → buffer → canal.
- `src/config.ts` — única lectura de `process.env`.
- `src/binance/` — clientes upstream (uno por stream). Reconexión exponencial; emiten eventos tipados normalizados.
- `src/store/` — estado en memoria (ring buffers, `OrderBook`).
- `src/ws/channel.ts` — `Channel<M>` genérico (snapshot al conectar + broadcast). Cada tipo de dato es una instancia montada en `index.ts`.
- `src/analysis/` — `engine.ts` (trades → barras footprint, CVD, señales), `detectors.ts` (funciones puras), `scenarios.ts` + `monitor.ts` (escenarios), `analysis.test.ts`.

- `src/polymarket/` — clientes de Polymarket (`chainlinkTwapClient` (TWAP, con credenciales de `.env.local`), `chainlinkClient` (spot, respaldo), `bookClient`, `api` HTTP, sobre `ReconnectingWs`) y `tracker.ts` (rotación, muestreo, historial; con prueba). `model.ts` + `strategy.ts` (motor de señales, funciones puras con prueba en `strategy.test.ts`) y `store.ts` (SQLite `node:sqlite`: markets completos + aggTrades y heatmap continuos) y `rebuild.ts` (rehace footprint/CVD/señales desde los aggTrades). Al cambiar modelo, detectores o reglas, subir `ENGINE_VERSION`. `src/clock.ts`: reloj de Binance del servidor para alinear los markets.

## Convenciones
- Imports relativos con extensión `.js` (ESM).
- Libro de órdenes: solo `DepthClient` lo escribe (ver ADR 0004). Los timestamps salen del reloj de Binance, no de `Date.now()`.
- Flujo fijo: `binance client → store.push → channel.broadcast`. Los canales no conocen a Binance.
- Un canal por tipo de dato: `new Channel<Msg>(snapshotFn)` y `mount(CHANNELS.x, canal)` en `index.ts` (ruta desde `CHANNELS` del protocolo; un `WebSocketServer` con `noServer` por ruta).
- Los trades entran por una sola tubería (`ingest` en `index.ts`): relleno REST + vivo, deduplicados por id. Nada consume trades por su cuenta.
- Lógica de análisis = funciones puras con umbrales en `DetectorConfig`; todo cambio lleva prueba (`npm run test -w @updown/server`).
- La memoria se mide en **tiempo** (`RETENTION_MS`), no en número de elementos.
- Al conectar un cliente: enviar `snapshot` y luego deltas. Nunca consumir upstream por cliente.
- Validar `Origin` en `upgrade` cuando `ALLOWED_ORIGIN` esté definido.
- Logs con prefijo `[modulo]`. Nada de `console.log` por cada trade.
- Nuevo canal: usar skill `add-ws-channel`.
