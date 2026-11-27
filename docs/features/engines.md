# Motores A y C y drawer de decisiones

**Estado**: implementada · 2026-11-25 · Decisiones: [ADR 0010](../decisions/0010-motor-sincronizado.md), [ADR 0011](../decisions/0011-tres-motores-guardados-y-base-v2.md), [ADR 0015](../decisions/0015-motores-predictivo-y-maker.md) (se elimina B, +300 ms, porque daba casi lo mismo que C)

Los motores D (predictivo) y E (libro de órdenes), que deciden cada 100 ms con otras reglas, están en [predictive-engines](predictive-engines.md). Comparten el drawer, el gráfico y la base con A y C.

## Por qué
Dos servidores (PC y Railway) con los mismos datos daban operaciones distintas en el mismo market. El motor original decidía con una "foto" por segundo sacada en un instante arbitrario del reloj interno de cada servidor (p. ej. x,47 s y x,66 s). El libro de Polymarket cambia muchas veces por segundo, y una diferencia de un tick bastaba para que uno vendiera y el otro no. Ese motor original se conserva en la rama `v1-personal-pc-overpowered`.

## Los dos motores (`polymarket/timedEngine.ts`)
Ambos aplican las mismas reglas (`SignalEngine`, [signal-engine](signal-engine.md)) con los mismos parámetros, una vez por cada segundo `T` del reloj de Binance. Se diferencian en **cuándo** deciden y con **qué datos**:

| Motor | Decide en | Datos de Polymarket y Chainlink | Variable |
|---|---|---|---|
| **A** | `T` + 0 ms (lo antes posible) | lo último recibido (`live`): el más rápido, pero depende de la latencia del servidor | `PM_ENGINE_A_DELAY_MS` (0) |
| **C** | `T` + 150 ms | solo mensajes con marca de tiempo ≤ T (`asOf`) | `PM_ENGINE_C_DELAY_MS` (150) |

- **Marcas de tiempo:** Polymarket marca en ms cada mensaje del libro, y Chainlink cada precio (`PmFeed` guarda una historia corta de 60 s por token).
- **Binance:** cada motor arma su propio CVD de 1 s (`SecondCvd`) con los aggTrades de tiempo < T, y usa las señales de footprint con tiempo ≤ T.
- **Determinismo:** C ve la misma foto en cualquier servidor si los datos llegan antes de su retraso.
- **Tracker sincronizado:** la rotación del market y el libro se mueven justo antes del paso de A en cada segundo, también sincronizados con Binance.

## Qué se guarda
Todos, en cada market guardado (base `polymarket-v2.db`):
- **Motor A:** sus muestras (`points`) y operaciones (`trades`/`pnl`). Sus muestras son también las del gráfico de precios, y con ellas se decide si el market está completo.
- **Motores C, D y E:** `engines.c` / `engines.d` / `engines.e` (`PmEngineRun`: muestras, operaciones, `pnl` y, en E, sus órdenes). Los markets de antes del 27 nov pueden traer `engines.b`, que ya no se lee.
- **Resumen por motor:** columnas en `markets` (`n_trades`/`invested`/`net` para A, `c_*`, `d_*` y `e_*`; `b_*` queda sin uso) y `engines` en `GET /api/markets`.
- **Por qué no se guarda el registro de decisiones:** el porqué de cada segundo (`PmDecision`) se reproduce exacto con `replayMarket(market, points)` sobre las muestras del motor.

Unos 60 KB por motor y market.

## Registro de decisiones (`PmDecision`)
Cada segundo, cada motor anota:
- las probabilidades: modelo, mercado y la mezcla con que decide;
- los precios y la posición;
- el EV de comprar cada lado y de vender lo que tiene;
- el **primer impedimento** por lado (`PmBlock`: EV bajo, espera, spread, calentando…).

Es solo informativo y no cambia ninguna decisión. Viaja por `/ws/engines` ([protocolo](../architecture/protocol.md)), que la web solo abre con el drawer abierto.

## Frontend
- **Gráfico:** una sección de probabilidad **por motor** (su P(Up) frente a la del mercado y sus compras y ventas). Debajo van los tokens, Binance, Chainlink, CVD y delta, comunes a todos.
- **Lista de operaciones** de todos los motores, con una columna "Motor". Debajo, el resultado de cada uno en el market.
- **Tabla de markets guardados:** "ops · neto" de A, C, D y E, y totales por motor.
- **Botón "Motores"** → drawer:
  - estado en vivo de los cuatro (P(Up), precios, posición, y comprar/vender con su edge frente al umbral y el motivo; D y E con sus umbrales);
  - línea de tiempo segundo a segundo, con las diferencias entre A y C (mismas reglas) resaltadas;
  - los cuatro en los últimos 24 markets guardados.

## Consumo
- **Servidor:** A y C, 2 `SignalEngine` y 2 CVD de 1 s por segundo, trivial. D y E: ver [predictive-engines](predictive-engines.md).
- **Red:** `/ws/polymarket` envía 4 muestras por segundo (más las órdenes de E). `/ws/engines` (registro) solo se abre bajo demanda.
- **Base:** unas 4 muestras de 1 s por segundo y market.

## Límites
- Un dato que tarde más que el retraso de C puede verse en un servidor y no en otro.
- A depende de la latencia por diseño.
- La volatilidad usa hasta 15 min de CVD: justo después de arrancar, dos servidores pueden diferir hasta acumular esa historia.
