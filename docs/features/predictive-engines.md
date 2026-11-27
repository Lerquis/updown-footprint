# Motores D (predictivo) y E (libro de órdenes)

**Estado**: implementada · 2026-11-27 · solo papel (D se puede seguir con [compras reales](live-trading.md); E no) · Decisión: [ADR 0015](../decisions/0015-motores-predictivo-y-maker.md)

**Objetivo**: ganar dinero **ejecutando de verdad**, no en papel. Una orden tarda 1–5 s en registrarse en Polymarket y, cuando el motor A (o C) señala, otros ya están entrando: el precio se va antes de que llegue la orden.

## Diagnóstico con los datos guardados (26–27 nov)
Datos: 299 markets con muestras de 1 s, 1,93 M aggTrades continuos y el heatmap del libro de Binance (~27 h).

| Hallazgo | Dato |
|---|---|
| La ventaja de A es casi toda "el mercado aún no se reajustó" | Replays de A ([replays](replays.md)): +421 USDC ejecutando al instante, +26 con 1 s, −91 con 2 s, −131 con 3 s. Movimiento en contra medio: 5¢ en 1 s |
| Polymarket va **varios segundos** detrás de Binance | De un movimiento de Binance en el último segundo, el token refleja el 32 % en 1 s, el 49 % en 2 s y el 64 % en 5 s |
| El mercado cierra solo ~40 % de la diferencia con el modelo | En 1 s, el 15 %; en 2 s, el 25 %; en 10 s, el 40 %. Después se estanca: el resto es error del modelo |
| Cerca del cierre manda el mercado | Log loss con < 20 s restantes: mercado 0,023, modelo 0,043 |
| El flujo de Binance predice los próximos segundos | Correlación fuera de muestra (OLS, 70/30 por tiempo): 0,18 a 1–2 s, 0,15 a 5 s, 0,12 a 10 s, 0,08 a 30 s |

Variables útiles: OFI de 1 y 3 s, retorno de 1 y 3 s y desequilibrio del libro a ±5 USD. No aportan: trades grandes (≥ 0,5 BTC), OFI de 30 s ni intensidad.

## Motor D: predictivo (taker) — `polymarket/predictive.ts`
Decide **cada 100 ms** con lo último recibido (no una vez por segundo).
1. **Deriva** (`micro.ts`): `z = Σ βᵢ·xᵢ` con las 5 variables; deriva = `clamp(3·z, ±1) · σ · √min(30, τ)` USD. Desplaza la media del modelo browniano de [signal-engine](signal-engine.md). Sustituye al `flow` de A, que llega tarde (barras de 1 min).
2. **Probabilidad:** mezcla en logit con el mercado, 0,6 modelo. En los últimos 30 s, 0,3.
3. **Compra** si `P − (ask + comisión + 0,5¢) ≥ 10¢`.
   - Pasados 20 s del inicio y con más de 20 s por delante.
   - Una compra por lado y market, spread ≤ 8¢.
   - **Límite = P − comisión − 3¢:** si al llegar la orden el precio ya superó el límite, no se ejecuta en vez de ejecutarse cara.
   - Sin ejecución, puede reintentar a los 5 s.
4. **Venta** si `bid − comisión − 0,5¢ − P ≥ 3¢`, con límite mínimo `P + comisión + 1,5¢`.
5. Tamaño Kelly como A. La posición solo cambia con ejecuciones (`onFill`), no con intenciones.

Backtest fuera de muestra (120 markets que no se usaron para elegir parámetros; ejecución al precio de `T + L`):

| Regla | L = 1 s | L = 2 s | L = 3 s |
|---|---|---|---|
| Tipo A (EV 4¢, sin límite) | +103 (7 %) | −127 (−9 %) | −163 (−11 %) |
| **D** (EV 10¢, deriva × 3, límite 3¢) | **+222 (62 %)** | **+111 (44 %)** | **+34 (21 %)** |

Son pocas operaciones (16–36 en prueba): indica la dirección, no es una garantía. Subir el EV mínimo da menos operaciones y más ROI; el límite y la deriva mejoran los tres retrasos.

## Motor E: libro de órdenes (maker) — `polymarket/maker.ts`
Deja **órdenes límite en reposo** (los makers no pagan comisión) y las gestiona cada 100 ms:
- **Entrada:** bid de un lado solo si el flujo de Binance empuja a su favor (`z ≥ 0,05`) y su probabilidad no cayó más de 1¢ en el último segundo.
  - Precio: `min(P − 5¢, mejor bid + 1 tick, ask − 1 tick)`. Si el spread lo permite, queda primera en un nivel nuevo; si no, se une al mejor bid (con cientos de tokens por delante).
- **Cancelación** (la idea murió), con motivo: `edge` (EV < 2,5¢), `drift` (el flujo se giró), `drop` (la probabilidad cayó), `closing` (últimos 20 s), `market` (fin).
  - Binance va por delante de Polymarket y cancelar tarda ~100 ms. Las órdenes taker de los demás se retienen 150–250 ms ([live-trading](live-trading.md)), así que se cancela antes de que llegue el golpe.
- **Reposición:** si el precio deseado cambia ≥ 2¢ tras 500 ms en el libro, se cancela. La nueva orden se coloca cuando la cancelación se confirma, nunca con dos órdenes vivas del mismo lado (`reconcile`).
- **Salida:** ask en reposo a `≥ P + 4¢`, que se recoloca igual. Si `P` cae 15¢ bajo la entrada, sale como taker (`stop`, límite bid − 5¢).

Backtest con muestras de 1 s: cancelar rápido pasó de −26 % a cerca de 0 %. No es concluyente, porque con 1 s no se puede simular la cola ni la velocidad real. **La prueba de E es su papel en vivo.**

## Papel realista — `polymarket/paper.ts`
- **D y salidas de E (`PaperTaker`):** la orden se ejecuta `PM_PAPER_TAKER_LATENCY_MS` (1500 ms) después, contra el **libro completo real** de ese instante.
  - Recorre niveles (`walkBook`) sin pasar del límite. Si no cabe, no se ejecuta o se ejecuta solo en parte.
  - `PmSignal.price` = precio medio real; `signalPrice` = precio al decidir.
- **E (`PaperMaker`):** la orden entra al libro tras 150 ms, **al final de la cola** de su precio (`queueAhead` = tamaño del nivel).
  - Se ejecuta cuando los trades de Polymarket (`last_trade_price`) consumen la cola o atraviesan su precio, o cuando aparece un nivel contrario que la cruza.
  - Si el nivel encoge sin trades, la cola se recorta. Cancelar tarda 100 ms y mientras tanto se puede ejecutar. Post-only: si al entrar cruzaría el libro, se rechaza.
- El papel de A y C sigue siendo optimista (precio del segundo de la señal): **no comparar sus netos con D y E como si fueran iguales**.

## Servidor
- `bookClient.ts` emite el libro completo (`book`), cada cambio de nivel (`level`) y los trades (`trade`); el tracker los reenvía.
- `pmBook.ts`: `TokenBook` (L2) y `walkBook`.
- `fastRunner.ts`: `FastRunner` programa D y E cada `PM_FAST_TICK_MS`.
  - Mantiene su CVD de 1 s (σ, basis), `MicroFlow` y el desequilibrio del libro de Binance (`OrderBook.sides()`).
  - Emite una muestra y un registro por segundo (`step`), las ejecuciones en papel (`fills` → `tracker.addSignals`), las órdenes de E (`order` → `tracker.addOrder`) y las órdenes de D al decidir (`intent` → `LiveTrader` si se eligió D).
- Se guardan en `PmRecord.engines.d/e` (E con `orders`) y en las columnas `d_*` / `e_*` de `markets`. `ENGINE_VERSION` 3.
- **Calibración:** `npm run calibrate -w @updown/server` recalcula los coeficientes con los aggTrades y el heatmap guardados y escribe `PM_CALIBRATION_PATH`. Se usa al reiniciar. El multiplicador 3 se eligió con los coeficientes por defecto.

## Frontend
- Una sección de probabilidad por motor (A, C, D, E).
- En D, cada operación va en el momento y precio de su ejecución, unida con una línea a la decisión.
- En E, cada orden es un tramo horizontal en su precio: continuo = ejecutada, discontinuo = cancelada, con tooltip de cola y motivo.
- La lista de operaciones muestra "señal→ejecución", el límite y "maker".
- Drawer de motores con tarjetas y umbrales propios de D y E. La comparación segundo a segundo es solo entre A y C (mismas reglas).
- Compras reales: botón "Motor D".

## Protocolo
[`/ws/polymarket`](../architecture/protocol.md#canal-wspolymarket-markets-btc-updown-5m) (`order`, `PmOrder`, campos nuevos de `PmSignal` y `PmPoint`) y [`/ws/engines`](../architecture/protocol.md#canal-wsengines-decisiones-de-los-motores-a-c-d-y-e).

## Límites y siguientes pasos
- **E no envía órdenes reales.** Hace falta ver su papel en vivo durante cientos de markets antes de conectarlo (`POST /order` GTC post-only, `DELETE /order`, canal de usuario para las ejecuciones).
- Sin datos sub-segundo de Polymarket guardados, D y E no tienen replay fiel. Las muestras de 1 s solo sirven para aproximar.
- Recalibrar (`npm run calibrate`) y revisar `PM_D_MIN_EDGE` y `PM_DRIFT_GAIN` cuando haya varios días más de datos.
- El papel de E supone que nuestras órdenes no mueven a los demás y que no hay cancelaciones por delante salvo lo que muestra el nivel.
