# apps/server

Node (ESM) + TypeScript + `ws`. Corre con `tsx` (dev y prod) porque `@updown/protocol` se consume como TS fuente.

## Estructura
- `src/index.ts` — composición: HTTP (`/health`), enrutado de `upgrade` por path, wiring upstream → buffer → canal.
- `src/config.ts` — única lectura de `process.env`.
- `src/binance/` — clientes upstream (uno por stream). Reconexión exponencial; emiten eventos tipados normalizados.
- `src/store/` — estado en memoria (ring buffers, `OrderBook`).
- `src/ws/channel.ts` — `Channel<M>` genérico (snapshot al conectar + broadcast). Cada tipo de dato es una instancia montada en `index.ts`.
- `src/analysis/` — `engine.ts` (trades → barras footprint, CVD, señales), `detectors.ts` (funciones puras), `scenarios.ts` + `monitor.ts` (escenarios), `analysis.test.ts`.

- `src/polymarket/` — clientes de Polymarket (`chainlinkTwapClient` (TWAP, con credenciales de `.env.local`), `chainlinkClient` (spot, respaldo), `bookClient`, `api` HTTP, sobre `ReconnectingWs`) y `tracker.ts` (rotación, muestreo, historial; con prueba). `model.ts` + `strategy.ts` (motor de señales, funciones puras con prueba en `strategy.test.ts`) y `store.ts` (SQLite `node:sqlite`: markets completos + aggTrades y heatmap continuos) y `rebuild.ts` (rehace footprint/CVD/señales desde los aggTrades). Al cambiar modelo, detectores o reglas, subir `ENGINE_VERSION`. `timedEngine.ts`: motores A (T+0, lo último recibido), B (T+300 ms) y C (T+150 ms) con datos "a fecha" (`PmFeed`, `SecondCvd`), programados con `scheduleEngine` sobre el reloj de Binance; prueba en `timedEngine.test.ts`. El tracker NO muestrea: recibe los pasos (`addStep`) y guarda los tres motores en el record (A en `points`/`trades`, B y C en `engines`). `SignalEngine.step` devuelve también `decision` (`PmDecision`, solo informativo: nunca debe cambiar la decisión). Canal `/ws/engines` con el registro de los tres. Base con generación (`config.DB_GENERATION`): cambiar el formato guardado = nueva generación (ADR 0011). `clobConnection.ts`: `ClobH2`, conexión HTTP/2 persistente y caliente al CLOB (usarla para todo lo que vaya al CLOB, ADR 0012). `liveTrader.ts`: `LiveTrader`, compras reales del motor C con el interruptor (`POST /api/trading/arm` + `TRADING_PASSWORD`), firma local con `OrderBuilder`, canal `/ws/trading`, topes duros (ADR 0014; prueba en `liveTrader.test.ts`). `latency.ts`: `LatencyMonitor` (latencia al CLOB cada 15 s, nunca opera: `POST /order` con una orden firmada con ceros (`buildProbeOrder`), rechazada al verificar la firma; canal `/ws/latency`; prueba en `latency.test.ts`). `src/clock.ts`: reloj de Binance del servidor para alinear los markets.
- `src/backup/` — `DbBackup` (VACUUM INTO en worker → gzip → R2/S3 cada hora y al apagar; retención `backupsToPrune`; `latest.json` nunca retrocede (`shouldMoveLatest`); restauración si falta la base; ADR 0013). Al apagar (SIGTERM) el backup final va primero y cada paso del apagado está aislado; `resolveDbPath` mete la base en el volumen de Railway, `s3.ts` (SigV4 sin dependencias, con prueba), `cli.ts` (`npm run backup`). Despliegue: `Dockerfile` + `railway.json` (contexto = raíz del repo), ver `docs/guides/deployment.md`.

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
