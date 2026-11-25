# Feed de AggTrades

**Estado**: implementada (2026-11-24); gráfica y columna Dólares añadidas.

**Objetivo**: mostrar en el frontend, en vivo y compartido entre usuarios, los aggTrades de Binance, en tabla y en gráfica estilo Bookmap.

## Servidor
- `binance/aggTradeClient.ts` conecta a `${BINANCE_WS_URL}/${SYMBOL}@aggTrade` (por defecto spot BTCUSDT), normaliza y reconecta.
- `store/tradeBuffer.ts` guarda los trades de los últimos `RETENTION_MS` (15 min, por tiempo y con tope `TRADES_MAX`); al arrancar se rellena por REST ([ADR 0005](../decisions/0005-retencion-15min-y-backfill.md)).
- `ws/aggTradesChannel.ts` sirve `/ws/aggtrades`.

## Frontend
- `lib/useAggTrades.ts`: hook; poda por tiempo con el `retentionMs` que envía el servidor (cubre la ventana de 15 m de la gráfica).
- Las burbujas y la línea de precio las dibuja `BookmapChart` (ver [heatmap-bookmap.md](heatmap-bookmap.md)); radio ∝ √USD, verde = compra agresora, roja = venta agresora.
- `components/TradesTable.tsx`: tabla shadcn (100 filas). Columna **Dólares** = `price × quantity` (derivado en cliente, no viaja por el protocolo); filas ≥ $100k resaltadas.

## Protocolo
Ver [protocol.md](../architecture/protocol.md#canal-wsaggtrades). Sin cambios.

## Pendiente / ideas
- Selector de símbolo, footprint por velas, persistencia, futuros USDT-M (`BINANCE_WS_URL`).
