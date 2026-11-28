# Guía de desarrollo

## Requisitos
Node ≥ 20 (probado en 24), npm ≥ 10.

## Arranque
```
npm install
npm run dev          # server http://localhost:4000, web http://localhost:3000
```
Copiar `apps/*/.env.example` a `.env` / `.env.local` si se quiere cambiar la configuración. El servidor tarda unos segundos en estar `ready` (relleno de 15 min de trades por REST).

## Variables de entorno
| App | Variable | Default | Uso |
|---|---|---|---|
| server | `PORT` | 4000 | Puerto HTTP/WS |
| server | `ALLOWED_ORIGIN` | vacío | Origin permitido en upgrade WS (vacío = todos) |
| server | `SYMBOL` | btcusdt | Símbolo |
| server | `BINANCE_WS_URL` | wss://stream.binance.com:9443/ws | Fuente spot |
| server | `BINANCE_REST_URL` | https://api.binance.com/api/v3 | Fuente spot: snapshot del libro y relleno de trades |
| server | `FUTURES_ENABLED` | true | Fuente futures en paralelo ([futures-source](../features/futures-source.md)) |
| server | `BINANCE_FUTURES_TRADES_WS_URL` | wss://fstream.binance.com/market/ws | Fuente futures: aggTrades. **No** usar `/ws`: ahí el aggTrade conecta pero no envía nada |
| server | `BINANCE_FUTURES_DEPTH_WS_URL` | wss://fstream.binance.com/public/ws | Fuente futures: libro (depth) |
| server | `BINANCE_FUTURES_REST_URL` | https://fapi.binance.com/fapi/v1 | Fuente futures: snapshot del libro y relleno |
| server | `FUTURES_DEPTH_SNAPSHOT_LIMIT` | 1000 | Niveles del snapshot del libro de futuros (máximo 1000) |
| server | `FUTURES_BACKFILL_DELAY_MS` | 600 | Pausa entre páginas del relleno de futuros (rate limit) |
| server | `FUTURES_DB_PATH` | junto a `PM_DB_PATH`: `polymarket-futures.db` | Base de futures (con la generación: `polymarket-futures-v2.db`) |
| server | `ETH_ENABLED` | true | ETH como segundo activo ([eth-asset](../features/eth-asset.md)); `FUTURES_ENABLED` vale para los dos |
| server | `ETH_SYMBOL`, `ETH_PM_SYMBOL`, `ETH_PM_SLUG_PREFIX` | ethusdt, ETH, eth-updown-5m | Símbolo de Binance, símbolo de crypto-price y prefijo del slug de Polymarket |
| server | `ETH_CHAINLINK_TWAP_SYMBOL`, `ETH_CHAINLINK_SYMBOL` | ethusd, eth/usd | Chainlink ETH/USD: TWAP (con credenciales CLOB) o spot del RTDS |
| server | `ETH_DEPTH_STEP`, `ETH_FOOTPRINT_TICK`, `ETH_IMBALANCE_MIN_VOL` | 0.05, 0.05, 1.5 | Equivalentes en ETH de `DEPTH_STEP`, `FOOTPRINT_TICK` e `IMBALANCE_MIN_VOL` |
| server | `ETH_STRENGTH` | true | SS: movimientos con fuerza del motor C con BTC de referencia ([sol-strength](../features/sol-strength.md)) |
| server | `ETH_DB_PATH`, `ETH_FUTURES_DB_PATH` | junto a `PM_DB_PATH`: `polymarket-eth.db`, `polymarket-eth-futures.db` | Bases de ETH (con la generación: `polymarket-eth-v2.db`) |
| server | `RETENTION_MS` | 900000 | **Memoria** de trades, heatmap y CVD (15 min). Ver ADR 0005 para cuánto cuesta subirla |
| server | `TRADES_MAX` | 100000 | Tope de seguridad de trades en memoria |
| server | `BACKFILL` | true | Rellenar la memoria por REST al arrancar |
| server | `DEPTH_STEP` | 1 | Tamaño del bucket de precio del heatmap |
| server | `DEPTH_RANGE_PCT` | 0.001 | Rango del heatmap: mid ± fracción |
| server | `DEPTH_INTERVAL_MS` | 1000 | Muestreo del libro (1 columna) |
| server | `DEPTH_HISTORY` | `RETENTION_MS / DEPTH_INTERVAL_MS` | Columnas en memoria |
| server | `DEPTH_SNAPSHOT_LIMIT` | 5000 | Niveles del snapshot REST |
| server | `BAR_MS` | 60000 | Duración de cada barra footprint |
| server | `BAR_HISTORY` | 60 | Barras cerradas conservadas |
| server | `FOOTPRINT_TICK` | 1 | Tamaño del nivel de precio del footprint |
| server | `IMBALANCE_RATIO` | 3 | Ratio de desequilibrio diagonal |
| server | `IMBALANCE_MIN_VOL` | 0.05 | Volumen mínimo (activo base) para contar un desequilibrio |
| server | `IMBALANCE_MIN_STACK` | 3 | Niveles consecutivos para "apilado" |
| server | `ANALYSIS_LOOKBACK_MS` | 300000 | Ventana de tendencia de precio y CVD |
| server | `ANALYSIS_RECENT_BARS` | 3 | Barras atrás que cuentan como "señal reciente" |
| server | `PM_HISTORY` | 24 | Markets de Polymarket terminados guardados en memoria (24 × 5 min = 2 h) |
| server | `PM_DB_PATH` | `data/polymarket.db` | SQLite: markets completos + todos los aggTrades y el heatmap (gitignored, crece sin límite). Se usa con la generación: `data/polymarket-v2.db`; la base sin sufijo es la generación anterior (se archiva una vez en R2, [ADR 0011](../decisions/0011-tres-motores-guardados-y-base-v2.md)) |
| server | `PM_FEE_RATE`, `PM_SLIPPAGE`, `PM_MIN_EDGE`, `PM_EXIT_MARGIN`, `PM_BANKROLL`, `PM_KELLY_FRACTION`, `PM_MAX_STAKE_PCT`, `PM_MAX_MARKET_PCT`, `PM_MODEL_WEIGHT`, `PM_FLOW_GAIN`, `PM_WARMUP_S`, `PM_NO_ENTRY_S` | 0.05, 0.005, 0.04, 0.015, 1000, 0.25, 0.05, 0.1, 0.6, 0.3, 20, 10 | Parámetros del motor de señales (ver [signal-engine](../features/signal-engine.md)) |
| server | `PM_ENGINE_A_DELAY_MS`, `PM_ENGINE_C_DELAY_MS` | 0, 150 | Retraso de los motores A y C tras cada segundo de Binance ([engines](../features/engines.md)) |
| server | `PM_LIVE_WS_URL`, `PM_BOOK_WS_URL`, `PM_GAMMA_URL`, `PM_SITE_URL` | URLs de Polymarket | Endpoints upstream |
| server | `PM_TWAP_SECONDS` | 60 | Ventana del TWAP de Chainlink para price to beat y cierre |
| server | `PM_CLOB_API_KEY`, `PM_CLOB_SECRET`, `PM_CLOB_PASSPHRASE` | (vacío) | Credenciales CLOB para el TWAP en vivo (PolyBolt). **Solo en `apps/server/.env.local`**; sin ellas se usa el spot del RTDS |
| server | `PREDICT_API_KEY` | — | API key de Predict.fun (REST de mainnet; **solo en `.env.local` / Railway**). Sin ella no se conocen las rondas, pero llega el precio ([predict-markets](../features/predict-markets.md)) |
| server | `PREDICT_ENABLED`, `PREDICT_ENGINES`, `PREDICT_REST_URL`, `PREDICT_WS_URL`, `PREDICT_SERIES`, `PREDICT_PRICE_FEED_ID` | true, true, api.predict.fun, ws.predict.fun/ws, btc-updown-5m, 1 | Predict.fun: serie y feed Chainlink del WS (1 BTC, 2 ETH, 3 BNB) |
| server | `PREDICT_PRIVATE_KEY`, `PREDICT_ACCOUNT` | — | Compras reales en Predict (**solo `.env.local` / Railway**): clave de la EOA, o de la wallet de Privy + dirección de la cuenta de Predict. Aprobaciones: `npm run predict:approvals -w @updown/server` (`-- --send` para enviarlas, con gas en BNB) |
| server | `PREDICT_LIVE_SCALE`, `PREDICT_LIVE_MIN_USD`, `PREDICT_LIVE_MAX_USD`, `PREDICT_LIVE_MAX_MARKET_USD`, `PREDICT_LIVE_SLIPPAGE_BPS`, `PREDICT_LATENCY_INTERVAL_MS` | 0.2, 1 (nunca < 1), 10, 40, 500, 15000 | Importes y deslizamiento de las compras reales en Predict (USDT) y latencia a su API |
| server | `PREDICT_FEE_RATE`, `PREDICT_BASIS_SECONDS`, `PREDICT_DB_PATH`, `PREDICT_FUTURES_DB_PATH` | 0.02, 5, data/predict.db, data/predict-futures.db | Motores de Predict: comisión (rate·min(p,1−p)), ventana del basis contra el Chainlink puntual y bases (con la generación: `predict-v2.db`) |
| server | `PM_CLOB_URL`, `PM_LATENCY_INTERVAL_MS`, `PM_LATENCY_KEEPALIVE_MS`, `PM_LATENCY_HISTORY` | clob.polymarket.com, 15000, 5000, 40 | Medición de latencia al CLOB ([latency](../features/latency.md)) |
| server | `PM_SIGNER_ADDRESS` | (vacío) | EOA que creó la API key (`POLY_ADDRESS`); sin ella la sonda autenticada responde 401. Solo en `.env.local` |
| server | `PM_WALLET_PRIVATE_KEY`, `TRADING_PASSWORD` | (vacío) | Compras reales del motor A o C; sin ellas, desactivado. **Solo en `.env.local`** ([live-trading](../features/live-trading.md)) |
| server | `PM_MAKER_CHECK_MAX`, `PM_MAKER_CHECK_REST_MS`, `PM_MAKER_CHECK_USD` | 30, 2000, 1 | Check maker: órdenes maker reales siguiendo a un motor (tope de órdenes, tiempo en el libro, importe mínimo en USDC; se activa en la web) ([latency](../features/latency.md)) |
| server | `PM_LIVE_SCALE`, `PM_LIVE_MIN_USD`, `PM_LIVE_MAX_USD`, `PM_LIVE_MAX_MARKET_USD`, `PM_LIVE_SLIPPAGE` | 0.2, 1, 10, 40, 1 | Importe y tolerancia de las compras reales (1 = sin límite de precio) |
| server | `PM_FUNDER_ADDRESS` | (vacío) | Proxy wallet de la cuenta: `maker` de la orden de prueba de latencia (firmada con ceros, nunca se ejecuta). Solo en `.env.local` |
| server | `PM_TWAP_WS_URL` | wss://ws-live-v2.polymarket.com/ws | Endpoint PolyBolt |
| server | `PM_SYMBOL`, `PM_VARIANT`, `PM_SLUG_PREFIX`, `PM_MARKET_MS` | BTC, fiveminute, btc-updown-5m, 300000 | Activo/timeframe (solo BTC 5m soportado) |
| server | `REPLAY_DIR` | data/replays | Copias de R2 descargadas e informe (`report.json`) de los [replays](../features/replays.md) |
| web | `NEXT_PUBLIC_WS_URL` | ws://localhost:4000 | Base WS del servidor |

## Verificación
- `npm run typecheck`, `npm run test -w @updown/server` (detectores, motor y escenarios) y `npm run build`.
- `GET /health` debe mostrar `ready: true`, `upstream: "connected"` y `depth.upstream: "connected"`; `memory` muestra cuánto hay guardado.
- Probar un canal sin UI: `new WebSocket("ws://localhost:4000/ws/orderflow")` desde Node 22+ (el primer mensaje es el `snapshot`).
- **Lógica de análisis nueva o cambiada ⇒ prueba unitaria** en `apps/server/src/analysis/analysis.test.ts` (son funciones puras, fáciles de probar).

## Replays (motor A con retraso)
`npm run replays -w @updown/server` descarga de R2 las bases v1 y v2 (necesita las variables `BACKUP_S3_*` en `apps/server/.env.local`), reproduce el motor A y escribe el informe. Se ve en `http://localhost:3000/replays` (solo por URL). Detalle: [replays](../features/replays.md).

## Procesos en Windows
`npm run dev` usa `tsx watch` y `next dev`. Si se mata solo el proceso que escucha el puerto, el *watcher* padre lo vuelve a levantar (y deja `EADDRINUSE` al reintentar). Detener el **árbol** (`taskkill /PID <padre> /T /F`, el padre se ve con `Get-CimInstance Win32_Process`). No ejecutar `next build` y `next dev` sobre la misma carpeta `.next` (borrar `apps/web/.next` si da `__webpack_modules__ … is not a function`).

## UI (shadcn)
Añadir componente: `cd apps/web && npx shadcn@latest add <nombre> --yes --overwrite`; revisar que los imports de `cn` apunten a `@/lib/utils` (ver ADR 0003).

## Producción
`npm run start -w @updown/server` (usa tsx) y `npm run build && npm run start -w @updown/web`. Definir `ALLOWED_ORIGIN` y `NEXT_PUBLIC_WS_URL` (wss://).
Servidor en la nube (Railway + volumen + backups `BACKUP_*` a R2, `npm run backup -w @updown/server`): [deployment.md](deployment.md).
