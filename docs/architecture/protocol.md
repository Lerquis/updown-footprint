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
| `snapshot` | `summary: MarketSummary \| null`, `history: MarketSummary[]`, `upstream` | Al conectar |
| `summary` | `summary` | Cada segundo |
| `change` | `summary` | Cuando cambia el sesgo o el conjunto de escenarios activos |
| `status` | `upstream` | Cambia el estado de la conexión a Binance |

`MarketSummary`: tendencias de precio y CVD (`up|down|flat`) sobre `lookbackMs`, `barDelta`, `signalIds` recientes, `scenarios: {id, weight}[]` (el más relevante primero), `score` (−100..100) y `bias`. Los textos de cada escenario viven en `SCENARIOS` (protocolo); ver [scenario-monitor](../features/scenario-monitor.md).

## Canal `/ws/polymarket` (markets BTC Up/Down 5m)

| `type` | Campos | Cuándo |
|---|---|---|
| `snapshot` | `current: PmMarket \| null`, `next`, `points: PmPoint[]`, `trades: PmSignal[]`, `history: PmRecord[]`, `historyMax`, `upstream` | Al conectar |
| `markets` | `current`, `next` | Rota el market o llega un dato nuevo (tokens) |
| `point` | `point: PmPoint` | Cada segundo (market en curso) |
| `signal` | `signal: PmSignal` | El motor señala comprar o vender un token en el market en curso |
| `record` | `record: PmRecord` | Market archivado (≈5 s tras terminar) y otra vez cuando llega el resultado oficial. El cliente hace upsert por `market.slug` |
| `status` | `upstream` | Cambia la conexión con Polymarket (libro de tokens o stream de Chainlink) |

- `PmMarket`: `slug`, `title`, `start/end` (ms, UTC, múltiplos de 5 min), `upToken/downToken`, `priceToBeat` (openPrice; null hasta que Polymarket lo publica), `closePrice` y `changePct` (null hasta resolver), `status` (`upcoming | live | resolving | closed`) y `result` (`up | down | null`, resultado oficial de Polymarket).
- `PmPoint`: `time`, `chainlink` (precio BTC/USD de Chainlink, TWAP de 60 s; spot si faltan credenciales; null hasta el primero), `upBid/upAsk/downBid/downAsk` (mejores precios de cada token, probabilidad 0-1) y lo que usa el motor: `binance` (spot), `basis` (Chainlink − media 60 s de Binance, suavizado), `sigma` (volatilidad, USD/√s), `flow` (-1..1) y `pModel` (P de Up según el motor).
- `PmRecord`: `market` + `points` + lo que el servidor tenía de Binance dentro de `[start, end)`: `bars` (footprint), `cvd`, `signals`; además `trades: PmSignal[]` (señales del motor), `pnl: PmPnl` (resultado de papel; `net`/`roi` null hasta resolver) y `complete` (el servidor tuvo datos de los 5 min; solo esos van a la base de datos).
- `PmSignal`: `action` (`buy | sell`), `side` (`up | down`), `reason` (`entry | exit | flip | hedge`), `price` (ask al comprar, bid al vender), `fee`, `shares`, `amount` (USDC), `pSide` (P del motor de que ese lado gane), `edge` (EV por token), `tau` (s que faltaban). Ver [signal-engine](../features/signal-engine.md).
- `upstream` = `connected` solo si están conectados el libro de tokens (market en curso) y el stream de Chainlink. Ver [polymarket-markets](../features/polymarket-markets.md).

## Otros endpoints
- `GET /health` → `{ ok, ready, upstream, memory: {trades, depthColumns, bars, cvdPoints, signals}, clients: {…por canal}, depth: {upstream}, polymarket: {upstream, chainlink, current, history, saved} }`. `ready` pasa a `true` cuando termina el relleno inicial.
- `GET /api/markets` → `PmMarketsResponse`: `{ total, markets: PmMarketRow[] }` con una fila resumen por market guardado en la base de datos (lo justo para la tabla del historial: price to beat, cierre, cambio %, resultado, delta footprint, Δ CVD, señales alcistas/bajistas, Up inicio→fin, operaciones del motor, invertido/vendido/neto, `engineVersion`, `tradesOk`). No incluye `points`, barras ni CVD. Parámetros opcionales: `limit` (por defecto todos), `from` / `to` (filtran por inicio en ms; `to` exclusivo) y `order=asc|desc` (por defecto `desc`, más recientes primero). CORS abierto salvo que `ALLOWED_ORIGIN` esté definido. `GET /api/markets/<slug>` → el `PmRecord` completo de un market guardado (404 si no existe; ~100 KB). El resumen se calcula al guardar (columnas de `markets`), así que listar cientos de markets no lee el JSON.
