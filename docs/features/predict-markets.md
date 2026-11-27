# Rondas de Predict.fun (BTC Up/Down 5m) con los motores A, C, D y E

**Estado**: implementada: motores en papel, compras reales con interruptor y latencia a la API de órdenes (2026-11-27). Decisión: [ADR 0017](../decisions/0017-predict-fun.md). Canales `/ws/predict` y `/ws/predict-engines` ([protocol.md](../architecture/protocol.md#canales-wspredict-y-wspredict-engines-predictfun)).

**Objetivo**: ver y operar en papel las rondas BTC Up/Down de 5 minutos de [Predict.fun](https://dev.predict.fun) (BNB Chain, colateral USDT) **igual que las de Polymarket**:
- la misma gráfica, con tooltip de hora y precios;
- los mismos motores A, C, D y E con sus mismas reglas, alimentados con el flujo de Binance de cada fuente (spot y futures);
- la misma tabla de markets guardados y el mismo drawer de motores.

La diferencia es que los motores se basan en el **precio puntual** de Chainlink y no en un TWAP.

## Cómo funciona Predict.fun (lo que importa aquí)
- **Series y rondas.** `btc-updown-5m` es una serie que se renueva cada 300 s. Cada ronda es una categoría con **un solo market** (Up/Down), con slug `btc-updown-5m-<inicio en s>`, **el mismo formato que Polymarket**. Existen también `eth-`/`bnb-updown-5m` y versiones de 15m, 1h y 1d.
- **Resolución con el precio puntual** del data stream Chainlink BTC/USDT (mid del top of book de Binance), sin TWAP. Gana Up si el cierre es mayor que la apertura; si empatan, se paga 50-50 y esa ronda queda sin resultado en nuestro sistema.
- **Un solo libro**, en el outcome `indexSet` 1 ("Up"). Down es el espejo: bid Down = 1 − ask Up y ask Down = 1 − bid Up, con los mismos tamaños.
- **Comisión taker**: `feeRateBps/10000 · min(p, 1 − p)` por share, con 200 bps en los markets de 5 minutos. El maker no paga. En Polymarket la fórmula es `feeRate · p · (1 − p)`.
- **API key.** El REST de mainnet exige `x-api-key` incluso para leer; se saca en developers.predict.fun. El WS es público. Testnet no tiene series de 5 minutos.

## Fuentes de datos
| Qué | De dónde |
|---|---|
| Ronda en curso y siguientes (título, `marketId`, price to beat) | REST `GET /v1/series/btc-updown-5m/rounds?status=ACTIVE` (`startPrice` es el price to beat) |
| Cierre y resultado | REST `…/rounds?status=ENDED` (`endPrice`) |
| Precio actual (lo usan los motores) | WS `chainlinkAssetPriceUpdate/1` (1 = BTC, 2 = ETH, 3 = BNB). **No está documentado.** Manda ~1 valor/s, duplicado; `publishTime` viene en segundos |
| Libro | WS `predictOrderbook/{marketId}`: el libro entero de Up en cada mensaje |

El WS manda un heartbeat cada 15 s que hay que devolver, o cierra la conexión. Ante el aviso `system` (reinicio del servidor) se reconecta y se rehacen las suscripciones.

## Servidor (`apps/server/src/predict/`)
Se reutiliza **la pila completa de Polymarket**: `PolymarketTracker`, `PmFeed`, `TimedEngine` (A y C), `FastRunner` (D y E con papel realista), `MarketStore` y los mismos mensajes. Para eso hay adaptadores:
- `api.ts`: `PredictMarketApi` implementa la `PolymarketApi` del tracker con las rondas del REST. Tiene una caché de 2 s compartida por las dos fuentes. Los tokens son sintéticos: `<marketId>:up` / `<marketId>:down`.
- `book.ts`: `PredictBook` implementa el `BookLike` del tracker:
  - el primer libro de cada conexión sale como `book` y los siguientes como cambios de nivel (`level`, con `diffLevels`);
  - Down se deriva con `mirrorBook`;
  - Predict no publica el tamaño de cada trade, así que no hay `trade`; el papel maker de E avanza la cola solo con los cambios de nivel.
- `wsClient.ts`: `PredictWs` gestiona el heartbeat, el aviso de reinicio y las suscripciones. Con un feed emite `price` (la misma interfaz que el cliente Chainlink de Polymarket); sin feed, solo sirve de cliente de libro.
- `model.ts`: funciones puras probadas en `predict.test.ts`: `parseRound` (descarta la ronda si `indexSet` 1 no es "Up"), `resultOf`, `tokenOf`/`parseToken`, `mirrorBook`, `diffLevels`, `levels`.
- `venue.ts`: `createPredictVenue` monta la pila sobre esos adaptadores **una vez por fuente**, desde `source.ts`:
  - recibe los aggTrades de la tubería `ingest`;
  - usa el libro de Binance de la fuente;
  - tiene base propia (`predict-v2.db` / `predict-futures-v2.db`, solo markets) con backups propios (`updown-predict/v2/`, `updown-predict-futures/v2/`);
  - la cobertura de aggTrades de un market la consulta a la base de la fuente;
  - canales `/ws/predict` y `/ws/predict-engines`, API `/api/predict/markets[/<slug>]` y `health.predict`;
  - **no tiene compras reales.**
- `index.ts` crea lo compartido: `PredictMarketApi` y el `PredictWs` del precio.

### Motores sin TWAP (`serverStrategy("predict")` / `serverFast("predict")`)
Mismos umbrales que en Polymarket (`PM_*`). Cambia lo que depende de cómo resuelve el mercado:
- `twapSeconds: 0`. `modelProbUp` usa entonces el precio puntual: media `x + deriva` y varianza `sigma²·tau`. No hay cola de TWAP conocida.
- `basisSeconds` (`PREDICT_BASIS_SECONDS`, 5 s). El basis es Chainlink puntual menos la media de Binance en una ventana corta, no en 60 s. Se suaviza con la misma EMA de 60 s.
- Comisión `feeKind: "min"` con `PREDICT_FEE_RATE` (0.02), también en el papel taker de D.

Polymarket no cambia: los campos nuevos son opcionales y por defecto valen lo de siempre.

## Frontend
- **El mismo `PolymarketPanel`** con `venue="predict"` (`lib/venue.ts`: rutas, textos, sin compras reales), debajo del de Polymarket.
- `usePolymarket(CHANNELS.predict)`, `useMarketRows`/`useFetchRecord` con `/api/predict/markets` y `useEngines(…, CHANNELS.predictEngines)`.
- `PolymarketChart` recibe el título de la franja de Chainlink (`chainTitle`).
- Las compras reales de Polymarket no se dibujan en Predict: los slugs coinciden, así que se filtran por mercado.

## Compras reales
Siguen al motor A, C o D de una fuente, con el mismo interruptor por market que en Polymarket (`TRADING_PASSWORD`; se apaga solo al terminar el market). Canal `/ws/predict-trading`, `POST /api/predict/trading/arm`.
- **Cuenta** (`predict/account.ts`, común a las fuentes):
  - Firma con `@predictdotfun/sdk` (EIP-712). Con una EOA basta `PREDICT_PRIVATE_KEY`. Con la **cuenta de Predict** (la smart wallet de la web) hacen falta `PREDICT_ACCOUNT` (su dirección, en predict.fun/portfolio) y `PREDICT_PRIVATE_KEY` (la clave de la wallet de Privy, que se exporta en predict.fun/account/settings).
  - Al arrancar **solo lee** de la cadena: que la wallet es dueña de la cuenta, las aprobaciones para operar y el saldo USDT (cada minuto).
  - **El login (JWT, 24 h) firma el mensaje de Predict, que acepta sus términos de servicio: solo se hace al activar el interruptor.** Con el JWT se suscribe a `predictWalletEvents/{jwt}`.
- **Aprobaciones**: `npm run predict:approvals -w @updown/server` las comprueba; con `-- --send` envía las que falten (una transacción por aprobación, con gas en BNB). Sin ellas el interruptor está desactivado.
- **Órdenes** (`predict/liveTrader.ts`): orden MARKET del SDK sobre el libro del lado que se opera (el de Down es el espejo del de Up). La compra va por importe (`valueWei`, `isMinAmountOut`) y la venta por cantidad.
  - Deslizamiento de A y C: `PREDICT_LIVE_SLIPPAGE_BPS` (5 %) sobre el peor nivel que se consume.
  - D usa su `limit`: el deslizamiento se calcula para que el peor precio firmado no lo supere, y si el libro ya está por encima, no se envía.
- **Mínimo**: una compra **nunca baja de 1 USDT**, el mínimo de Predict (`PREDICT_LIVE_MIN_USD` no puede ser menor). El SDK redondea hacia abajo (1 USDT firma 0,999972), así que `buyAmountsAtLeast` sube el presupuesto de centavo en centavo hasta que lo firmado llegue al mínimo. Si no llega, no se envía. Una venta admite desde 0,01 shares. Modos de importe:
  - Proporcional: paper × `PREDICT_LIVE_SCALE`, entre el mínimo y `PREDICT_LIVE_MAX_USD`.
  - Mínimo.
  En los dos, con tope `PREDICT_LIVE_MAX_MARKET_USD` por market y fuente.
- **Ejecución asíncrona.** El `201` de `POST /v1/orders` solo significa aceptada (estado `pending`). Lo ejecutado llega por los eventos de la wallet:
  - `orderTransactionSuccess` trae tamaño, importe y comisión; la de una compra se cobra en tokens, la de una venta en USDT;
  - `matchedAt` = su `timestamp` (reloj de Predict);
  - `orderNotAccepted`, `orderCancelled` y `orderExpired` sin ejecución pasan a `unmatched`.
  El tope por market reserva lo pedido hasta saber lo ejecutado.
- La posición real sale de esas ejecuciones; las ventas venden lo que se tiene.

## Latencia a la API de órdenes
`predict/latency.ts` (`PredictLatencyMonitor`, común a las fuentes, cada `PREDICT_LATENCY_INTERVAL_MS`): mismas sondas que la [latencia a Polymarket](latency.md) por la conexión HTTP/2 caliente de la cuenta. Canal `/ws/predict-latency`, panel "Latencia a Predict".
- Sondas: `connect`, `edge` (PING HTTP/2), `ping` y `book` (`/v1/auth/message`, `/v1/markets/{id}/orderbook`), `auth` (`GET /v1/orders` con el JWT) y `order` (`POST /v1/orders`).
- **La orden de prueba nunca puede ejecutarse**, por tres barreras: firma de ceros, expiración a 30 s (el mínimo son 2 min) y post-only a 0,01. Si Predict respondiera alguna vez con un código menor de 300, la sonda se apaga para siempre.
- Sin sesión, `auth` y `order` responden 401 en el gateway. Con sesión (al activar), la orden llega hasta la validación.
- Firmar una orden real tarda ~1–4 ms (va en `signMs` de cada operación).

## Pendiente / ideas
- Comparar Predict con Polymarket en la misma ventana (mismo slug): ¿el precio puntual adelanta al TWAP?
- Papel maker más fiel, si Predict publica el tamaño de cada trade.
- ETH y BNB (`PREDICT_SERIES` + `PREDICT_PRICE_FEED_ID`).
