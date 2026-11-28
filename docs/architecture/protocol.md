# Protocolo WebSocket servidor → frontend

Fuente de verdad en código: `packages/protocol/src/index.ts`. Este doc es su descripción; mantenerlos sincronizados.

## Reglas generales
- Un canal por tipo de dato, ruta `/ws/<nombre>`. Constantes en `CHANNELS`.
- Mensajes JSON con campo discriminante `type`.
- Todos los canales son solo servidor → cliente.
- Al conectar, el servidor envía primero `snapshot` y después deltas.
- Los `snapshot` grandes viajan comprimidos (permessage-deflate, umbral 1 KB); los deltas no.
- Todo `snapshot` de datos históricos incluye `retentionMs` (la memoria del servidor): el cliente poda lo más viejo que `último − retentionMs`.
- Cambios incompatibles: crear ADR y versionar la ruta (`/ws/v2/...`).

## Activos y fuentes
Cada canal y la API de markets/trading existen **una vez por activo y fuente** (`MarketAsset`: `btc` | `eth`, [ADR 0018](../decisions/0018-eth-como-segundo-activo.md); `MarketSource`: `spot` | `futures`, [ADR 0016](../decisions/0016-fuente-futures-en-paralelo.md)). Los mensajes son los mismos.
- `sourcePath(source, path, asset = "btc")`: BTC spot usa la ruta tal cual (`/ws/orderflow`, `/api/markets`); BTC futures inserta la fuente (`/ws/futures/orderflow`, `/api/futures/markets`, `/api/futures/trading/arm`, `/api/futures/latency/maker`); ETH inserta `eth` delante (`/ws/eth/orderflow`, `/ws/eth/futures/orderflow`, `/api/eth/markets`, `/api/eth/futures/trading/arm`).
- Cada fuente tiene sus motores, su base, sus compras reales y su check maker. `/ws/latency` repite en todas las mismas muestras de latencia al CLOB, con el check maker de cada fuente.
- `/health`, `/api/replays` (solo BTC spot) y `/api/compare` no llevan activo ni fuente en la ruta.
- En ETH, `symbol` es `ETHUSDT`, `PmMarket` son los markets `eth-updown-5m-…` y `chainlink` es el TWAP de ETH/USD.
- En futures, `PmPoint.binance` es el último precio del perpetuo y `basis` es Chainlink − media del perpetuo.

## Reloj
Todos los timestamps (`AggTrade.time`, `DepthColumn.time`, `FootprintBar.start`, `CvdPoint.time`, …) están en el **reloj de Binance**. El navegador estima el desfase con el PC en `web/lib/exchangeClock.ts`; nunca usar `Date.now()` directo para posicionar datos en el eje de tiempo.

## Canal `/ws/aggtrades`

| `type` | Campos | Cuándo |
|---|---|---|
| `snapshot` | `symbol`, `retentionMs`, `trades: AggTrade[]` (antiguo→reciente), `upstream` | Al conectar |
| `trade` | `trade: AggTrade` | Cada aggTrade recibido de Binance |
| `status` | `upstream: UpstreamState` | Cambia el estado de la conexión a Binance |

`AggTrade`: `id` (agg id), `symbol`, `price`, `quantity`, `time` (ms), `isBuyerMaker` (true ⇒ agresión vendedora).
`UpstreamState`: `connecting | connected | reconnecting`.

## Canal `/ws/depth` (heatmap de liquidez)

| `type` | Campos | Cuándo |
|---|---|---|
| `snapshot` | `symbol`, `step`, `retentionMs`, `columns: DepthColumn[]` (antiguo→reciente), `upstream` | Al conectar |
| `column` | `column: DepthColumn` | Cada `DEPTH_INTERVAL_MS` (1 s) |
| `status` | `upstream` | Cambia el estado de la conexión a Binance |

`DepthColumn`: `time`, `mid`, `lo` (precio inferior del bucket 0, múltiplo de `step`), `q: number[]` (liquidez en activo base; `q[i]` cubre [`lo + i·step`, `lo + (i+1)·step`), bids y asks sumados). Columnas alineadas en una rejilla de precio absoluta.

## Canal `/ws/orderflow` (footprint, CVD, señales)

| `type` | Campos | Cuándo |
|---|---|---|
| `snapshot` | `symbol`, `tick`, `barMs`, `retentionMs`, `bars`, `cvd`, `signals`, `upstream` | Al conectar |
| `bar` | `bar: FootprintBar` | Cada segundo (barra en formación, `closed:false`) y al cerrarse (`closed:true`). El cliente reemplaza por `start` |
| `cvd` | `point: CvdPoint` | Cada segundo |
| `signal` | `signal: OrderflowSignal` | Al cerrar una barra en la que se detecta algo |
| `status` | `upstream` | Cambia el estado de la conexión a Binance |

- `FootprintBar`: `start`, `open/high/low/close`, `volume`, `delta` (ask − bid), `cvdClose`, `closed`, `levels: [precio, bidVol, askVol][]` (ascendente; **bidVol = ventas agresivas que golpean el bid**, **askVol = compras agresivas que golpean el ask**), `imbalances: {price, side}[]`.
- `CvdPoint`: `time` (fin del segundo), `cvd`, `price` (último precio), `vol` (volumen del segundo). El CVD arranca en 0 al comienzo de la memoria del servidor.
- `OrderflowSignal`: `id`, `type` (`stackedImbalance | absorption | exhaustion | cvdDivergence`), `bias` (`bullish | bearish`), `barStart`, `time`, `priceLo/priceHi`, `strength`, `link?` (divergencias: puntos precio/CVD). Definiciones exactas en [orderflow-signals](../features/orderflow-signals.md).

## Canal `/ws/analysis` (monitor de escenarios)

| `type` | Campos | Cuándo |
|---|---|---|
| `snapshot` | `summary: MarketSummary \|ms | null, status | null`, `history: MarketSummary[]`, `upstream` | Al conectar |
| `summary` | `summary` | Cada segundo |
| `change` | `summary` | Cuando cambia el sesgo o el conjunto de escenarios activos |
| `status` | `upstream` | Cambia el estado de la conexión a Binance |

`MarketSummary`: tendencias de precio y CVD (`up|down|flat`) sobre `lookbackMs`, `barDelta`, `signalIds` recientes, `scenarios: {id, weight}[]` (el más relevante primero), `score` (−100..100) y `bias`. Los textos de cada escenario viven en `SCENARIOS` (protocolo); ver [scenario-monitor](../features/scenario-monitor.md).

## Canal `/ws/polymarket` (markets BTC Up/Down 5m)

| `type` | Campos | Cuándo |
|---|---|---|
| `snapshot` | `current: PmMarket \|ms | null, status | null`, `next`, `points: PmPoint[]`, `trades: PmSignal[]`, `history: PmRecord[]`, `historyMax`, `upstream` | Al conectar |
| `markets` | `current`, `next` | Rota el market o llega un dato nuevo (tokens) |
| `point` | `engine`, `point: PmPoint` | Cada segundo y motor (market en curso) |
| `signal` | `engine`, `signal: PmSignal` | Un motor compra o vende en el market en curso |
| `record` | `record: PmRecord` | Market archivado (≈5 s tras terminar) y otra vez cuando llega el resultado oficial. El cliente hace upsert por `market.slug` |
| `status` | `upstream` | Cambia la conexión con Polymarket (libro de tokens o stream de Chainlink) |
| `strength` | `slug`, `strength: PmStrengthSet` | Solo fuentes con SS: señales del market en curso, todas las variantes, cuando aparece una nueva |
| `ref` | `slug`, `label`, `point: PmRefPoint` | Solo fuentes con SS: tokens de 1 s de la referencia (market de BTC) en el market en curso |

- `PmMarket`: `slug`, `title`, `start/end` (ms, UTC, múltiplos de 5 min), `upToken/downToken`, `priceToBeat` (openPrice;ms | null, status | null hasta que Polymarket lo publica), `closePrice` y `changePct` (null hasta resolver), `status` (`upcoming | live | resolving | closed`) y `result` (`up | down | null`, resultado oficial de Polymarket).
- `PmPoint`: `time`, `chainlink` (precio BTC/USD de Chainlink, TWAP de 60 s; spot si faltan credenciales;ms | null, status | null hasta el primero), `upBid/upAsk/downBid/downAsk` (mejores precios de cada token, probabilidad 0-1) y lo que usa el motor: `binance` (spot), `basis` (Chainlink − media 60 s de Binance, suavizado), `sigma` (volatilidad, USD/√s), `flow` (-1..1) y `pModel` (P de Up según el motor).
- `PmRecord`: `market` + `points` + lo que el servidor tenía de Binance dentro de `[start, end)`: `bars` (footprint), `cvd`, `signals`; además `trades: PmSignal[]` (señales del motor A), `pnl: PmPnl` (resultado de papel; `net`/`roi`ms | null, status | null hasta resolver), `engines` (`c`: `PmEngineRun` con `points`, `trades` y `pnl`; los markets guardados antes pueden traer `b`, `d` y `e`, motores eliminados, que se ignoran) y `complete` (el servidor tuvo datos de los 5 min; solo esos van a la base de datos).
- El `snapshot` trae `engines: { c }` (`PmLiveRun`: `points`, `trades`) del market en curso.
- `PmSignal`: `action` (`buy | sell`), `side` (`up | down`), `reason` (`entry | exit | flip | hedge`), `price` (ask al comprar, bid al vender), `fee`, `shares`, `amount` (USDC), `pSide` (P del motor de que ese lado gane), `edge` (EV por token), `tau` (s que faltaban). Ver [signal-engine](../features/signal-engine.md).
- SS ([sol-strength](../features/sol-strength.md)), solo en fuentes con SS activado:
  - `PmRecord.strength?: PmStrengthSet` (`Record<PmStrengthVariant, PmStrengthEvent[]>`; variantes `STRENGTH_VARIANTS`: `sol` calibrada, `base` sin calibrar) y `PmRecord.ref?: PmRef`. El servidor los añade al servir el market (historial del `snapshot`, `record`, `GET /api/markets/<slug>`); no se guardan.
  - El `snapshot` trae `strength` y `ref` del market en curso.
  - `PmStrengthEvent` (una señal, en el segundo en que se detecta, solo con datos hasta ese segundo):
    - `time` (ms), `dir` (`up|down`), `p`: P(Up) del motor C al detectarla.
    - `from/move/seconds`: P(Up) al inicio de la ventana medida (que termina en `time`), su cambio y su duración.
    - `z` (sorpresa frente al ruido previo), `score` (0-100).
    - `refUp`: token Up de la referencia al detectarla; `refUpMove`: su cambio en la misma ventana (0-1).
  - `PmRef`: `label` (BTC) y `points: PmRefPoint[]` (`time`, `up`, `down`: mitad del spread de cada token del market de BTC del mismo tramo).
- `upstream` = `connected` solo si están conectados el libro de tokens (market en curso) y el stream de Chainlink. Ver [polymarket-markets](../features/polymarket-markets.md).

## Canal `/ws/engines` (decisiones de los motores A y C)
Registro de decisiones de los motores A y C (B, D y E se eliminaron, [ADR 0020](../decisions/0020-eliminar-motores-d-y-e.md)). Bajo demanda: el frontend solo lo abre con el drawer de motores abierto. Ver [engines](../features/engines.md).
- `snapshot`: `{ thresholds: PmEngineThresholds (los de A y C), engines: PmEngineInfo[] ({id, mode: live|asOf, delayMs, thresholds}), decisions: { a|c: { slug, decisions: PmDecision[] } } }` (market en curso, antiguo → reciente).
- `decision`: `{ engine: "a"|"c", slug, decision: PmDecision }`, una por segundo y motor. Si `slug` cambia, ese motor empezó un market nuevo y el cliente vacía su lista.
- `PmDecision`: `time`, `tau`, precios (`chainlink`, `upBid/upAsk/downBid/downAsk`), `pModel` (solo modelo), `pMarket` (mercado), `pUp` (mezcla con que decide); por lado (`up`/`down`): `shares`, `buyEdge`/`buy`, `sellEdge`/`sell`, donde `buy`/`sell` es un `PmBlock` (`ok` = ejecuta, o el primer impedimento); `signals` emitidas ese segundo.

## Canal `/ws/latency` (latencia a Polymarket)
El servidor mide cada `intervalMs` (15 s) la latencia al CLOB de Polymarket (nunca opera: `POST /order` lleva una orden completa firmada con ceros y Polymarket la rechaza al verificar la firma). Ver [latency](../features/latency.md).
- `snapshot`: `{ intervalMs, target (host), region ("local" o región de Railway), transport ("h2"), authReady, history: LatencySample[] (antiguo → reciente), historyMax, upstream }`.
- `sample`: `{ sample: LatencySample }`, una por ronda.
- `status`: `{ upstream }`: `connected` si el último `ping` respondió.
- `snapshot` incluye `maker: { state: MakerProbeState, history: MakerProbeSample[] }`; `makerSample` `{ sample }` al terminar cada orden (upsert por `signalId`) y `makerState` `{ state }` al activar/desactivar o cambiar el gasto. Check maker (órdenes maker reales siguiendo a un motor, [latency](../features/latency.md#check-maker-órdenes-límite-reales-motor-e)):
  - `MakerProbeState`: `available`, `reason`, `enabled`, `engine` (`a|c|d`), `done`, `max`, `restMs`, `minUsd`, `minShares`, `maxMarketUsd`, `currentSlug`, `spentUsd`, `position` (`up`/`down`: tokens).
  - `MakerProbeSample` (ms desde el envío de cada petición): `signalId`, `engine`, `slug`, `action`, `side`, `signalTime`, `signalPrice`, `price` (orden maker), `size`, `time` (envío), `signMs`, `postMs`, `postStatus`, `orderStatus`, `orderId`, `userAckMs`, `bookMs`, `firstFillMs`, `filledShares`, `cancelMs`, `cancelStatus`, `userCancelMs`, `bookGoneMs`, `exchangePlaceMs`, `exchangeCancelMs`, `status` (`filled|partial|unfilled|rejected|skipped|error`), `error`.
  - `POST /api/latency/maker` con `x-trading-password` y `MakerProbeRequest` `{ enabled, engine? }` → `{ state }` o `{ error, state? }` (401 contraseña incorrecta · 409 no disponible).
- `LatencySample`: `time` (inicio de la ronda, reloj de Binance), `probes: { connect|edge|ping|book|auth|order: { ms: number | null, status: number | null, detail? (mensaje de Polymarket), error? (red) } }`, `prepMs` (preparar la orden: cuerpo + HMAC), `estimateMs` (`prepMs` + `order`, o `auth`, o `ping` si fallan; el precio sale del libro por WS).

## Canal `/ws/trading` (compras reales, motor A o C)
Compras/ventas reales que siguen al motor elegido (A o C), con el interruptor activado y solo en el market en curso. Ver [live-trading](../features/live-trading.md).
- `snapshot`: `{ state: LiveTradingState, trades: LiveTrade[] }`.
- `state`: `{ state }` cuando se activa o desactiva el interruptor, cambia el market o cambia la posición.
- `trade`: `{ trade: LiveTrade }` en cada orden enviada u omitida, y otra vez cuando llega `matchedAt`. El cliente hace *upsert* por `signalId`.
- `LiveTradingState`: `enabled`, `disabledReason`, `armedSlug` (market activado o null), `engine` (`a|c|d`), `sizing` (`scaled|min`), `userStream` (estado del canal de usuario de Polymarket), `currentSlug`, `limits` (`scale`, `minUsd`, `maxUsd`, `maxMarketUsd`, `slippage`), `position` (`up`/`down`: `shares`, `costUsd`), `spentUsd`.
- `LiveTrade`:
  - qué y por qué: `signalId`, `engine`, `slug`, `action`, `side`, `reason`;
  - la señal: `signalTime` y `signalPrice` (reloj de Binance), `paperAmount`;
  - lo pedido: `requestedUsd` (compra) o `requestedShares` (venta), `limitPrice`;
  - tiempos: `sentAt`, `respondedAt`, `latencyMs`, `signMs`, `matchedAt` (ms, reloj de Polymarket, desde el canal de usuario);
  - resultado: `status` (`matched|delayed|unmatched|rejected|error|skipped`), `filledShares`, `filledUsd`, `avgPrice`, `slippage` (+ = peor que la señal), `orderId`, `detail`.
- `POST /api/trading/arm` con la cabecera `x-trading-password` y el cuerpo `TradingArmRequest` `{ slug, armed, engine?, sizing? }` → `{ state }` o `{ error, state? }`. Respuestas: 401 contraseña incorrecta · 409 no disponible o market que no está en curso.

## Canales `/ws/predict` y `/ws/predict-engines` (Predict.fun)
Los mismos motores A y C sobre las rondas BTC Up/Down 5m de Predict.fun, por fuente (`/ws/futures/predict`…). Ver [predict-markets](../features/predict-markets.md).
- `/ws/predict`: **mismos mensajes que `/ws/polymarket`** (`PolymarketServerMessage`). `PmMarket.upToken/downToken` son tokens sintéticos `<marketId>:up|down`; `priceToBeat`/`closePrice` son `startPrice`/`endPrice` de Predict; `PmPoint.chainlink` es el precio **puntual** (no TWAP); `downBid/downAsk` se derivan del libro de Up (1 − precio). `upstream` = `connected` si lo están el libro y el WS de precio.
- `/ws/predict-engines`: mismos mensajes que `/ws/engines` (`EnginesServerMessage`).
- `GET /api/predict/markets` y `/api/predict/markets/<slug>`: mismas respuestas que `/api/markets` (base de Predict de la fuente).
- `/ws/predict-trading`: mismos mensajes que `/ws/trading` (`TradingServerMessage`). `LiveTrade.status` puede ser `pending` (aceptada, a la espera de los eventos de la wallet); `matchedAt` es el `timestamp` del primer `orderTransactionSuccess`. `LiveTradingState.balanceUsd` = saldo USDT de la cuenta; `limits.slippage` = `PREDICT_LIVE_SLIPPAGE_BPS` / 10000. `POST /api/predict/trading/arm`: como `/api/trading/arm`.
- `/ws/predict-latency`: mismos mensajes que `/ws/latency` (`LatencyServerMessage`) **sin `maker`** (es opcional: en Predict no hay check maker).

## Otros endpoints
- `GET /health` → la fuente BTC spot en la raíz, como siempre, la de BTC futures en `futures` y las de ETH en `eth: { spot, futures }` (mismos campos, más `db` y `live`; `{ enabled: false }` si está desactivada). Spot en la raíz: `{ ok, ready, upstream, memory: {trades, depthColumns, bars, cvdPoints, signals}, clients: {…por canal}, depth: {upstream}, latency: {authReady, last}, predict: {upstream, book, price, rest (ok|error|nokey|pending), current, priceToBeat, history, saved, db, engines} (o `{ enabled: false }`; también en `futures`), polymarket: {upstream, chainlink, current, history, saved, engines: {a|c: {market, decisions, mode, delayMs}}} }`. `ready` pasa a `true` cuando termina el relleno inicial.
- `GET /api/markets` → `PmMarketsResponse`: `{ total, markets: PmMarketRow[] }` con una fila resumen por market guardado en la base de datos (lo justo para la tabla del historial: price to beat, cierre, cambio %, resultado, delta footprint, Δ CVD, señales alcistas/bajistas, Up inicio→fin, operaciones del motor, invertido/vendido/neto, `engineVersion`, `tradesOk`). No incluye `points`, barras ni CVD. Parámetros opcionales: `limit` (por defecto todos), `from` / `to` (filtran por inicio en ms; `to` exclusivo) y `order=asc|desc` (por defecto `desc`, más recientes primero). CORS abierto salvo que `ALLOWED_ORIGIN` esté definido. `GET /api/markets/<slug>` → el `PmRecord` completo de un market guardado (404 si no existe; ~100 KB). El resumen se calcula al guardar (columnas de `markets`), así que listar cientos de markets no lee el JSON.
- `GET /api/compare?limit=&asset=btc|eth` (por defecto 96, máximo 500; activo por defecto `btc`) → `CompareResponse` `{ markets: CompareMarketRow[], totals: Record<PmEngineId, CompareEngineTotals>, futuresEnabled }`. Compara los markets guardados por las dos fuentes (emparejados por slug, de reciente a antiguo). Por motor, `CompareEngineMarket` trae:
  - `spot` / `futures` (`PmEngineSummary`) y el lado de la primera entrada (`spotSide`, `futuresSide`);
  - `leadMs`: primera entrada de spot − la de futures, solo si es el mismo lado. Positivo significa que futures entró antes;
  - `priceDiff`: precio spot − precio futures. Positivo significa que futures compró más barato.
  `CompareEngineTotals` suma el P&L, las operaciones y lo invertido, y cuenta `sameSide`, `futuresFirst`, `spotFirst`, `onlySpot`, `onlyFutures` y `oppositeSide`. Da también `avgLeadMs`, `medianLeadMs` y `avgPriceDiff`. Ver [futures-source](../features/futures-source.md).
- `GET /api/replays` → `PmReplayReport`: replays del motor A con ejecución retrasada ([replays](../features/replays.md)). `delays` (s; 0 = referencia), `sources` (copias de R2 usadas) y `markets` (`PmReplayMarket`, antiguo → reciente: `slug`, `start`, `end`, `result`, `generation` v1/v2 y `runs`, un `PmReplayRun` por retraso con sus `fills` (`PmReplayFill`: hora y precio de la señal, hora y precio de la ejecución retrasada, tokens, USDC y `status` filled/missed/noPosition) y su `pnl`). Sirve el archivo que genera `npm run replays`; si no existe, 404 con `{ error }`. CORS como `/api/markets`.
