# Fuente futures y comparativa spot vs futures

**Estado:** implementada (27 nov). Decisión: [ADR 0016](../decisions/0016-fuente-futures-en-paralelo.md).

## Objetivo
Correr el sistema completo también con el perpetuo BTCUSDT USDⓈ-M de Binance y comparar, en los mismos markets de Polymarket, si los motores **entran antes y más barato** que con spot. El problema que se busca resolver es que en compras reales entramos 1–5 s tarde y el ask ya se movió.

## Servidor
- `src/source.ts`: `createSource(opts, shared)` es una fuente completa. La parte de Binance son trades, relleno, libro, orderflow y escenarios. Encima van los motores A/C/D/E, el tracker, `MarketStore`, `DbBackup`, `LiveTrader`, `MakerProbe` y los canales. `splitSource(path)` quita `/futures` de la ruta.
- `src/index.ts`: comparte Chainlink y `LatencyMonitor`, crea `spot` y `futures` (`FUTURES_ENABLED`), y monta los canales de cada fuente con `sourcePath`. También enruta la API y sirve `/health`: spot en la raíz, como siempre, y futures en `futures`.
- **Rutas WS de futuros:** Binance las separó. El aggTrade va por `wss://fstream.binance.com/market/ws`; en `/ws` conecta pero no envía nada (27 nov). El libro va por `/public/ws`. `AggTradeClient` tiene un vigilante: si pasan 30 s sin trades con la conexión abierta, avisa y reconecta.
- `binance/depthClient.ts`: modo `futures`. El primer diff cumple `U <= lastUpdateId <= u` y los siguientes `pu == u anterior` (`bridgesDiff`, `isStaleDiff`, con prueba en `depthClient.test.ts`).
- `binance/backfill.ts`: pausa entre páginas configurable (futures 600 ms por el peso 20 de `/fapi/v1/aggTrades`).
- `polymarket/compare.ts`: `compareEngine` / `compareMarkets` / `compareTotals`, funciones puras con prueba en `compare.test.ts`.
  - **Primera entrada:** primera compra con `reason: "entry"`.
  - **Adelanto:** `time` spot − `time` futures, solo si las dos entraron por el mismo lado. Positivo significa que futures entró antes.
  - **Precio:** precio spot − precio futures. Positivo significa que futures compró más barato.
  - `GET /api/compare?limit=` cachea las filas de markets ya resueltos en las dos fuentes.
- Logs de futures con prefijo `futures:` (`[futures:binance]`, `[futures:depth]`, …).

## Frontend
- `lib/source.tsx`: `SourceProvider`, `useSource` y `useStoredSource` (la elección se recuerda en `localStorage`).
  - `useWsChannel` y `useApiUrl` añaden la fuente a la ruta, así todos los hooks y componentes sirven igual para las dos.
  - `SourceDashboard` vuelve a montar el panel al cambiar de fuente.
- Selector **Spot / Futures** y enlace a `/compare` en la cabecera. Las tarjetas de Polymarket y de compras reales indican la fuente de sus motores.
- `/compare` (`components/CompareView.tsx`, `lib/useCompare.ts`): totales por motor y tabla por market, con 4 h, 8 h o 24 h de markets.

## Protocolo
`MarketSource`, `SOURCES`, `sourcePath` y los tipos `Compare*`: ver [protocol.md](../architecture/protocol.md#fuentes-spot-y-futures).

## Cómo leer la comparativa
- Lo que más importa es el **adelanto medio y la mediana**, y la **diferencia de precio**. Si futures entra unos cientos de ms antes y algún centavo más barato de forma sistemática, merece la pena operar con futures.
- El stream de aggTrades de futuros llega **agrupado cada 100 ms**, así que adelantos menores no son significativos.
- "Opuesto" cuenta los markets en que cada fuente entró por un lado distinto. Si son muchos, las dos fuentes no se están leyendo igual.

## Pendiente / ideas
- Medir el adelanto contra el **movimiento del ask de Polymarket**, no solo entre fuentes.
- Motor mixto: precio y basis de spot con el flujo de futures.
- Recalibrar la deriva (D/E) con aggTrades de futuros (`npm run calibrate` sobre su base).
