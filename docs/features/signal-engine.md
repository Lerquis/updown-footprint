# Motor de señales Up/Down 5m

**Estado**: implementada (2026-11-24), **solo señales** (no ejecuta órdenes). Decisión: [ADR 0008](../decisions/0008-motor-de-senales-y-base-de-datos.md). Código: `apps/server/src/polymarket/{model,strategy,store}.ts`. Reemplaza al [monitor de escenarios](scenario-monitor.md) en la UI.

**Objetivo**: rentabilidad esperada, no acertar el resultado. Cada segundo el motor compara lo que *vale* cada token (probabilidad propia) con lo que *cuesta* comprarlo o *rinde* venderlo (precios reales + comisión + deslizamiento) y señala solo cuando el valor esperado (EV) supera un margen. Puede comprar, vender antes del cierre, comprar el otro lado (voltear) o cubrirse.

## 1. Probabilidad de que el market termine Up
Polymarket resuelve Up si el TWAP de 60 s de Chainlink al cierre ≥ el TWAP al inicio (price to beat). El precio se modela como movimiento browniano con volatilidad `σ` (USD/√s):

- **x** = precio actual en unidades Chainlink = Binance + `basis`, con `basis` = Chainlink(TWAP) − media de 60 s de Binance (suavizado con EMA de vida media 60 s).
- **Faltan más de 60 s** (`τ > T`): cierre ≈ media de un tramo de 60 s que empieza en `τ − T`; varianza `σ²(τ − T + T/3)`.
- **Faltan menos de 60 s**: parte del TWAP ya es conocida (`tailAvg`, media de x desde `end − 60 s`) y solo queda el resto: `mean = (1−w)·tailAvg + w·x`, `var = (w·σ)²·τ/3`, `w = τ/T`.
- `P_modelo = Φ((mean − K) / sd)`, con `K` = price to beat y `sd` con suelo de un segundo de volatilidad.
- **σ**: retornos de 5 s (el precio del último trade a 1 s tiene ruido de rebote bid/ask) con EWMA de vida media 150 s sobre los últimos 15 min.
- **Flujo** (`flow`, -1..1): mitad señales de footprint recientes (signo = sesgo, peso por tipo, decaen con vida media 45 s) y mitad delta de CVD de 20 s relativo al volumen. Solo **desplaza la media**: `mean += flowGain · flow · σ · √min(τ, 30)` (poco peso a propósito).
- **Mezcla con el mercado**: en logit, `modelWeight` (0.6) modelo + 0.4 mercado. Protege de errores del modelo; con datos suficientes se puede subir.

## 2. Reglas de decisión (por segundo, `SignalEngine.step`)
Con `P_lado` = probabilidad de que ese lado gane y `fee(p) = feeRate · p · (1−p)` ([comisiones](https://docs.polymarket.com/trading/fees): 0.05 en BTC 5m, solo taker):

- **Comprar** el lado si `EV = P_lado − (ask + fee(ask) + slippage) ≥ minEdge` (0.04), spread ≤ 0.08, pasados `warmupS` (20 s) y antes de `noEntryS` (10 s) finales, una entrada por lado, máx. 4 compras por market, espera de 10 s entre señales del mismo lado.
- **Vender** una posición si `bid − fee(bid) − slippage − P_lado ≥ exitMargin` (0.015): vender vale más que mantener hasta el pago de 1 (que no paga comisión). Es el *corte de pérdida* y la *toma de ganancia* en una sola regla: no hay objetivos de %.
- **Voltear** (`flip`): si en el mismo segundo se vende un lado y se compra el otro. **Cubrirse** (`hedge`): comprar el otro lado sin vender el primero.
- **Tamaño**: Kelly fraccionado `kellyFraction · (P − c)/(1 − c) · bankroll` (0.25), tope `maxStakePct` (5 %) por entrada y `maxMarketPct` (10 %) por market, mínimo 5 USDC. `bankroll` (1000) es solo de referencia.

## 3. Resultado de papel
`PmPnl` por market (se asume seguir todas las señales con los precios reales): `invested`, `sold`, tokens abiertos y `net` = ventas + pago de los tokens ganadores − invertido (null hasta que el market resuelve). El panel suma los markets mostrados. Con pocos markets **no es estadísticamente concluyente**.

## Base de datos
SQLite (`node:sqlite`, sin dependencias; `PM_DB_PATH`, por defecto `apps/server/data/polymarket.db`, gitignored; modo WAL). Tres tablas, para poder reproducir y calibrar sin perder nada que no se pueda recuperar:

- **`markets`**: el `PmRecord` completo en JSON **solo si** el market está resuelto **y completo** (`isComplete`): Chainlink, Binance y precios de ambos tokens en ≥ 98 % de los 300 s, sin huecos de más de 3 s y cubriendo los dos bordes. Un market al que el servidor llegó tarde o con cortes se queda en memoria, marcado ◔ en la tabla, y no se guarda. Además guarda `engine_version` (`ENGINE_VERSION` en `store.ts`; subirla al cambiar modelo, detectores o reglas), `params` (configuración efectiva del motor, detectores y rejilla del heatmap) y `trades_ok`.
- **`agg_trades`**: **todos** los aggTrades de Binance, de forma continua (`id`, `time`, `price`, `qty`, `sell`), no solo los de los markets. Incluye el relleno histórico al arrancar; `INSERT OR IGNORE` por id. Con ellos se rehacen footprint, CVD y señales (`rebuildOrderflow`).
- **`depth_columns`**: columnas del heatmap de liquidez (1 por `DEPTH_INTERVAL_MS`, cantidades como Float32). El libro histórico no se puede recuperar, por eso se guarda también fuera de los markets.

`trades_ok` indica que los aggTrades cubren `[start − 10 min, end]` sin perder ninguno (los ids de Binance son correlativos) y con los bordes dentro de 5 s. El margen de 10 min es la historia que el motor necesita (σ, CVD, footprint). Si es falso (p. ej. el primer market tras arrancar) el market se guarda igual —los `points` bastan para `replayMarket`— pero el footprint no se puede reconstruir con fidelidad.

Los buffers de aggTrades y heatmap se vuelcan a disco una vez por segundo en una transacción (y al apagar). Se conservan sin límite; borrar el archivo reinicia el histórico. Al arrancar se recargan los últimos `PM_HISTORY` markets.

- `replayMarket(market, points, cfg)` reproduce un market con otros parámetros usando los `sigma`, `basis` y `flow` guardados en cada `PmPoint`.
- `rebuildOrderflow(store, start, end, engineCfg)` rehace `bars`, `cvd` y `signals` de un market desde `agg_trades` con el mismo `OrderflowEngine` del servidor (misma configuración → mismo resultado). Para recalcular `flow` con otros detectores o pesos, partir de ahí.
- `GET /api/markets` lista un resumen de todos los markets guardados ([protocolo](../architecture/protocol.md)); el resumen se guarda en columnas de `markets` al guardar (y se rellena al arrancar en bases antiguas).
- `bars`, `cvd` y `signals` dentro del JSON del market son redundantes (derivables); se conservan para mostrar el historial al instante.

Estas reglas las aplican dos motores (A y C) que deciden en instantes y con datos distintos; ambos se guardan: [engines](engines.md).

## Límites conocidos
- Los pesos de flujo, `flowGain`, `modelWeight` y `minEdge` son **priors conservadores**, no calibrados. Calibrar con los markets guardados (cientos) antes de confiar en el resultado.
- Solo se ve el mejor bid/ask, no la profundidad: tamaños grandes tendrían más deslizamiento que el supuesto.
- Las señales de footprint se detectan al cerrar la barra de 1 min (hasta 60 s de retraso).
- El modelo es gaussiano sin saltos: subestima colas (movimientos bruscos).

## Frontend
`PolymarketChart`: sección superior con la P(Up) del motor (violeta) frente a la del mercado (blanco) y las compras (▲ C) / ventas (▼ V) con lado y precio, más una línea vertical que las cruza con el resto de gráficos. `PolymarketPanel`: P(Up) y flujo en vivo, lista de operaciones del market mostrado, columna Motor/Neto en el historial y el total.
