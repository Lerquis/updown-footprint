# Markets de Polymarket (BTC Up or Down 5m)

**Estado**: implementada (2026-11-24). Decisión: [ADR 0007](../decisions/0007-polymarket-en-servidor.md). Canal `/ws/polymarket` ([protocol.md](../architecture/protocol.md#canal-wspolymarket-markets-btc-updown-5m)).

**Objetivo**: ver el market en curso en tiempo real (precio de los tokens Up/Down) y **revisar los anteriores junto al footprint/CVD/señales de Binance** de esos mismos 5 minutos, para buscar si los impulsos del flujo dan alguna ventaja.

## Qué se muestra y qué no
- Se muestra el **precio de los tokens Up y Down** (mejor bid/ask, en ¢), el **precio de Binance** y el **precio de Chainlink** (la fuente de Polymarket), y sobre cada uno las señales de orderflow (apilados, absorción, agotamiento, divergencias). En Binance la señal va en su zona de precio; en los tokens y en Chainlink se ancla al precio de ese instante.
- También el **price to beat**, el **cierre** y el **% de cambio** de cada market, y la diferencia entre Chainlink y el price to beat. No se consumen los trades de Polymarket.
- El **resultado** (Up/Down) es el oficial: `outcomesBySlug` de `past-results`.
- **Price to beat y cierre = TWAP**: Polymarket resuelve con el TWAP de Chainlink (ventana `PM_TWAP_SECONDS`, 60 s), así que se piden a `crypto-price` con `twapEnabled=true&twapLookbackSeconds=60`. Sin esos parámetros la API devuelve el *spot*, que puede **contradecir** el resultado oficial (visto: cierre < apertura y aun así gana Up). Con TWAP, apertura/cierre y `outcomesBySlug` coincidieron en todos los markets que se probaron. Los `openPrice/closePrice/percentChange` de `past-results` son spot: no se usan. Si aun así un market no cuadra, la UI lo marca con ⚠.

## Servidor (`apps/server/src/polymarket/`)
- **Market actual**: slug `btc-updown-5m-<inicio en s>` (inicio = múltiplo de 300 s sobre el reloj de Binance, `clock.ts`). `api.ts`: Gamma `/events/slug/<slug>` (tokens Up/Down) `polymarket.com/api/crypto/crypto-price` con TWAP (`openPrice` = **price to beat**, existe desde que empieza el market y se reintenta cada 3 s; `closePrice` cuando `completed`) y `polymarket.com/api/past-results` con `includeOutcomesBySlug` (resultado oficial; `currentEventStartTime` = fin del market, `pastEventSlugs` = su slug). El % de cambio se calcula con el open/close TWAP.
- **Chainlink (precio en vivo)**: `chainlinkTwapClient.ts` → **TWAP de 60 s** de Chainlink por PolyBolt (`wss://ws-live-v2.polymarket.com/ws`), el mismo cálculo con que resuelve Polymarket y coherente con el price to beat. Flujo: `auth` con credenciales CLOB (`apiKey/secret/passphrase`) → `authed` → `subscribe` canal `price.crypto.twap` (`btcusd`, `window_seconds: 60`, `provider: chainlink`) → `subscribed`; llega un snapshot de ~2 min y luego 1 valor/s. No usa PING de texto (el servidor manda pings de protocolo). Si el servidor rechaza la autenticación, espera 30 s y reintenta. **Sin credenciales** cae al feed antiguo `chainlinkClient.ts` (RTDS `ws-live-data`, spot, sin auth; Polymarket manda migrarlo). El último valor se copia a cada `PmPoint`.
- **Credenciales**: `PM_CLOB_API_KEY`, `PM_CLOB_SECRET`, `PM_CLOB_PASSPHRASE` en `apps/server/.env.local` (gitignored; los scripts `dev`/`start` lo cargan con `--env-file-if-exists`). Nunca en `.env.example`, en el repo ni en logs. Para este canal no hizo falta la API key de Chainlink.
- **Tiempo real**: `bookClient.ts` (WS `market` del CLOB: mejor bid/ask de Up y Down; un cliente por market) sobre `ReconnectingWs` (reconexión + PING de texto).
- **`PolymarketTracker`** (`tracker.ts`, 1 Hz): rota solo al cambiar la ventana, muestrea un `PmPoint` por segundo y 5 s después del fin archiva un `PmRecord` (market + puntos + barras footprint, CVD y señales de `[start,end)`). Luego pregunta cada 3 s por el resultado oficial y reemite el record (`status: closed`, `result`); mientras no llegan resultado **y** cierre TWAP, el market está *resolviendo*.
- **Base de datos**: los markets resueltos y **completos** se guardan en SQLite y se recargan al arrancar ([signal-engine](signal-engine.md#base-de-datos)).
- **Memoria**: últimos `PM_HISTORY` (24 = 2 h) markets; se pierden al reiniciar (a propósito: de momento solo revisión rápida; la base de datos queda para después). El footprint de un market solo existe si el servidor ya tenía esos minutos (relleno de 15 min al arrancar).

## Frontend
- `lib/usePolymarket.ts`, `components/PolymarketPanel.tsx` (selector En vivo / markets cerrados, precios Up/Down, tabla de historial con delta, Δ CVD, nº de señales y precio de Up inicio→fin; **sale de la API `GET /api/markets` (todos los markets guardados en la base de datos, paginada de 50 en 50), no de la memoria del canal**; al abrir uno que ya no está en memoria se pide completo a `GET /api/markets/<slug>`; `lib/useMarketRows.ts`) y `PolymarketChart.tsx` (SVG; mismo eje de 5 min: precio de Up y Down; precio de Binance con las señales en su zona; precio de Chainlink con las señales ancladas y la línea del price to beat; precio de Up y Down con cada señal anclada al precio de Up en el instante de su detección y una línea vertical tenue que la cruza con CVD y delta; CVD; delta por barra; tooltip).

## Pendiente / ideas
- Guardar en base de datos para acumular cientos de markets; estadísticas señal/flujo vs resultado.
- Pre-suscribirse al libro del siguiente market; otros activos y timeframes (15m, 1h).
