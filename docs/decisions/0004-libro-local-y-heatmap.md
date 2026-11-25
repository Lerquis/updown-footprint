# 0004 — Libro de órdenes local y heatmap muestreado

- **Estado**: aceptada · 2026-11-24

## Contexto
El heatmap estilo Bookmap necesita liquidez en profundidad. El stream parcial `@depth20` solo cubre centavos en BTC, inservible.

## Decisión
- `DepthClient` sigue el procedimiento oficial: stream `@depth@100ms` bufferizado + snapshot REST (5000 niveles), descarta diffs viejos, valida continuidad (`U == prev.u + 1`) y hace resync reconectando si hay hueco.
- `OrderBook` guarda precio→cantidad. Cada `DEPTH_INTERVAL_MS` (1 s) se agrega a buckets de `DEPTH_STEP` dentro de mid ± `DEPTH_RANGE_PCT` y se emite una `DepthColumn` densa (`q[]`), no el libro completo.
- Las columnas se estampan con el reloj de Binance (`E` del diff), igual que los trades, para que ambas capas alineen.

## Consecuencias
- Ancho de banda bajo (~0,8 KB por columna por segundo y cliente); snapshot de 10 min ≈ 450 KB.
- Spot usa REST `/api/v3`; futuros requeriría `BINANCE_REST_URL=https://fapi.binance.com/fapi/v1` y un límite de snapshot ≤ 1000 (no probado).
- La liquidez lejos del mid solo aparece si Binance la entregó en el snapshot o si cambia después.
