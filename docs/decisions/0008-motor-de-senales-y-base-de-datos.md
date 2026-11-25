# 0008 — Motor de señales por valor esperado y SQLite de markets completos

- **Estado**: aceptada · 2026-11-24

## Contexto
Con precio de Binance, footprint, CVD, tokens de Polymarket, price to beat y Chainlink ya disponibles, se quiere un motor que genere señales de compra/venta de Up/Down en markets de 5 min. El criterio es la **rentabilidad**, no acertar el resultado ni mantener hasta el final.

## Decisión
- El motor corre en el servidor (regla 8: funciones puras con prueba). Estima la probabilidad de Up con un modelo de precio (distancia al price to beat, tiempo, volatilidad, TWAP de cierre de 60 s) + un pequeño desplazamiento por flujo, mezclada con la probabilidad del mercado.
- Señala solo si el **EV neto** (comisión de taker `0.05·p·(1−p)`, deslizamiento, spread real) supera un margen; las salidas se deciden con la misma regla (vender vale más que mantener). Tamaño por Kelly fraccionado. Sin objetivos de % ni "mantener hasta el final".
- Solo señales (sin ejecución); el resultado se mide en **paper** con precios reales.
- Persistencia en **SQLite con `node:sqlite`** (integrado en Node ≥ 22.5; sin dependencia nativa que compilar en Windows). Solo se guardan markets **resueltos y completos** (datos de los 5 min); los incompletos quedan en memoria y se marcan.
- La base guarda también lo no recuperable de Binance: todos los aggTrades (continuo) y las columnas del heatmap; footprint/CVD/señales son derivables (`rebuildOrderflow`). Cada market anota `engine_version`, `params` y `trades_ok`. Se conserva además el JSON completo del market (hay disco de sobra y evita recalcular para mostrar el historial).
- El monitor de escenarios sale del dashboard (el canal y el código se conservan).

## Consecuencias
- Cada `PmPoint` guarda las entradas del motor (`binance`, `basis`, `sigma`, `flow`, `pModel`) para poder reproducir y calibrar sin rehacer el footprint.
- Los parámetros iniciales son priors: la validez estadística depende de acumular cientos de markets completos y repetirlos con `replayMarket`.
- `node:sqlite` es API en estabilización; si cambiara, el acceso está aislado en `store.ts`.
