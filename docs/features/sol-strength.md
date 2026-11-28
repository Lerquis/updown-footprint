# SS (Sol Strength): movimientos con fuerza del motor C

**Estado:** implementada (28 nov), solo informativa: no genera órdenes ni compras. Activa en el hueco "ETH", que durante la prueba consume Solana (ver [eth-asset](eth-asset.md)).

## Objetivo
Dar una señal cuando la P(Up) del motor C hace un movimiento brusco, hacia arriba o hacia abajo, con una fuerza de 0 a 100. Cuentan los picos y también cualquier tramo que recorre mucho en poco tiempo.

**Es en tiempo real (causal):** cada segundo se decide solo con los datos hasta ese segundo, igual que en vivo. La señal se marca en el segundo en que se detecta, no donde empezó ni donde terminó el movimiento. Al llegar más datos, las señales pasadas no cambian, así que lo que se ve en el historial es lo que se habría visto en vivo. Al lado se muestran los tokens Up/Down del market de BTC de ese mismo tramo, para ver si los dos markets se movieron a la vez.

Hay dos variantes (`PmStrengthVariant`):
- **`sol` · SS Solana (calibrado):** exige fuerza 35. Avisa un poco más tarde pero con más confirmación, y en una subida o bajada larga vuelve a avisar a los 45 s.
- **`base` · SS base (sin calibrar):** sin fuerza mínima. Avisa en cuanto se cumple el umbral, una vez por movimiento.

## Algoritmo (`apps/server/src/polymarket/strength.ts`, prueba en `strength.test.ts`)
Sobre las muestras de 1 s del motor C (`pModel`), en cada segundo t:
1. **Ruido previo (σ):** mediana de |cambio de 1 s| × 1,4826 de los 60 s anteriores al inicio de la ventana. Tiene un suelo de 0,006 para que en un tramo plano cualquier tic no cuente como pico.
2. **Candidato:** para cada ventana de 2, 3, 5, 8, 12, 20 y 30 s que termina en t se calcula el cambio `d` y su **sorpresa** `z = |d| / (σ·√segundos)`. Hace falta `|d| ≥ 8 puntos` y `z ≥ 3`; de las ventanas que lo cumplen se queda la de más fuerza. Los primeros 10 s del market no cuentan, porque el modelo está arrancando.
3. **Disparo:** un candidato con fuerza ≥ `minScore` da señal si su sentido está armado. Tras una señal, ese sentido no vuelve a avisar hasta que:
   - el movimiento termina (3 s sin candidatos de ese sentido),
   - llega una señal del sentido contrario,
   - o pasan `maxSeconds` (45 s en SS Solana; nunca en SS base).
4. **Fuerza:** `100·(1 − e^(−puntos·z/120))`. Crece con lo que recorre y con lo brusco que es.

Los umbrales están en `STRENGTH_CONFIGS` (`DEFAULT_STRENGTH` y `BASE_STRENGTH`). Con los últimos 40 markets de SOL salen unas 9 señales por market con SS Solana y 12 con SS base.

## Servidor
- Se activa con `AssetMarket.strength` (`config.eth.strength`, variable `ETH_STRENGTH`, activo por defecto). BTC no lo tiene.
- **No se guarda:** `source.ts` lo calcula al servir cada market a partir de `engines.c.points` (`withStrength`, con caché por slug). Aplica en el historial del `snapshot`, en el mensaje `record` y en `GET /api/markets/<slug>`. El record guardado no cambia, así que todos los markets guardados ya lo tienen.
- **Market en curso:** se recalcula con cada muestra de C y se envía `strength` cuando aparece una señal nueva.
- **Referencia BTC (tokens):**
  - Cada fuente expone `refFeed` (`RefFeed`: tokens Up/Down de 1 s de sus markets y `onPoint`). `index.ts` le pasa a SOL spot la de BTC spot y a SOL futures la de BTC futures.
  - Los tokens salen de las muestras del motor A del market de BTC con el mismo inicio (en memoria o en su base). Si BTC no guardó ese market (estaba incompleto), no hay referencia.
  - Cada señal lleva `refUp` (token Up de BTC al detectarla) y `refUpMove` (su cambio en la misma ventana).

## Frontend
- `usePolymarket`: guarda `strength` y `reference` del market en curso (mensajes `strength` y `ref`).
- `PolymarketChart`:
  - El motor C sale una vez por variante (SS Solana y SS base). Cada señal es un punto en la P(Up) del segundo de detección, con una línea vertical, la flecha y la fuerza (`ssMarks`).
  - Bajo los tokens del activo van los tokens Up/Down de BTC del mismo tramo, una sección por variante, con el punto sobre el token Up de BTC en ese segundo.
  - La tooltip muestra la hora, la P(Up) de la ventana (de→al detectar), segundos, sorpresa y el cambio del token Up de BTC.
- `PolymarketPanel`: lista de señales SS bajo el gráfico, por variante. Nombres en `STRENGTH_LABEL` (`lib/engines.ts`).
- En SOL el gráfico solo tiene el motor C (`ASSET_INFO.eth.charts = ["c"]`). Las tablas y totales siguen mostrando A y C.

## Protocolo
`PmStrengthVariant`, `PmStrengthSet`, `PmStrengthEvent`, `PmRef`, `PmRecord.strength` / `ref`, mensajes `strength` y `ref`: ver [protocol.md](../architecture/protocol.md#canal-wspolymarket-markets-btc-updown-5m).

## Pendiente / ideas
- Calibrar los umbrales con más markets.
- Ver si un SS con BTC quieto anticipa algo (¿revierte?) antes de convertirlo en señal de compra.
