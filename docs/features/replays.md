# Replays del motor A con ejecución retrasada

**Estado**: implementada · 2026-11-26

**Objetivo**: ver qué habría pasado si cada orden del motor A se hubiera ejecutado **1 s después** de la señal (y 2 o 3 s, para comparar). En las [compras reales](live-trading.md) la señal → ejecución ronda 1 s, así que este es uno de los peores escenarios realistas.

## Qué se reproduce
- **Motor:** el motor A con las reglas actuales (`SignalEngine` + `serverStrategy()`, los mismos parámetros que el servidor). Se re-ejecuta con `replayMarket` sobre las muestras guardadas de A (`PmRecord.points`), igual en v1 y v2. Así la referencia (0 s) y el retraso salen de las mismas señales.
- **Las decisiones no cambian.** El motor decide en el segundo `T` igual que siempre: las reglas no dependen del precio al que se ejecutó.
- **Cambia la ejecución.** Se hace con la muestra de `T + retraso`, la primera con tiempo ≥ `T + retraso − 200 ms`. En v1 las muestras no caen en el segundo exacto, de ahí el margen.
  - **Compra:** al ask de ese instante, con el mismo importe en USDC que la señal. Salen otros tokens: `importe / (ask + comisión + deslizamiento)`.
  - **Venta:** al bid de ese instante, de los tokens que de verdad se compraron.
  - Comisión (`feeRate`) y deslizamiento (`slippage`) son los mismos que en el paper.
- **Órdenes que no se ejecutan:**
  - `missed`: sin ask o bid en ese instante, o el market ya cerró. Una venta `missed` se mantiene hasta el pago.
  - `noPosition`: una venta cuya compra no se ejecutó.
- Retrasos calculados: 0 (referencia), 1, 2 y 3 s.

Código: `apps/server/src/polymarket/replay.ts` (`executeWithDelay`, `replayRecordDelayed`, funciones puras; prueba en `replay.test.ts`).

## De dónde salen los datos
Solo del bucket R2 (`BACKUP_S3_*`). **No se usan las bases locales**, para no repetir datos. `npm run replays -w @updown/server` (`src/replay/build.ts`):
- **v2** (`<prefijo>v2/polymarket-<fecha>.db.gz`): cada copia es la base entera. Se toma la más reciente y, si la base se vació alguna vez, la última copia antes de cada caída brusca de tamaño (`pickSnapshots`).
- **v1**, de dos sitios:
  - las copias horarias de la **raíz** del prefijo (`<prefijo>polymarket-<fecha>.db.gz`). Antes de la generación v2 los backups no tenían carpeta propia (`pickSnapshots`, mismo criterio que v2);
  - el archivo final `<prefijo>archive/polymarket-railway-*`. Las `-local-` se descartan porque son la base del PC (`pickV1Archives`).
- El script imprime primero todo lo que hay en el bucket, para comprobar qué se usa.
- Cada market se reproduce una sola vez, aunque esté en varias copias. La copia más reciente tiene prioridad.
- Las copias se guardan en `REPLAY_DIR/src` (por defecto `apps/server/data/replays`, gitignored) y no se vuelven a bajar si no cambian.
- El informe va a `REPLAY_DIR/report.json`. Para actualizarlo, volver a ejecutar el comando.

Prueba de las fuentes: `src/replay/sources.test.ts`.

## Servidor y frontend
- `GET /api/replays` sirve `report.json` ([protocolo](../architecture/protocol.md#otros-endpoints)). Sin informe responde 404 con el comando a ejecutar. Es un archivo ya calculado: no hace trabajo en el servidor en vivo.
- Página `/replays` (`apps/web/app/replays/page.tsx`, `components/ReplaysView.tsx`, `lib/useReplays.ts`). Solo por URL: no tiene enlace en la navegación.
  - **Selectores:** retraso (0/+1/+2/+3 s) y base (todas, v1, v2).
  - **Cifras:** neto de referencia frente al neto con retraso, diferencia, precio medio de ejecución frente a la señal y órdenes sin ejecutar.
  - **Gráfica:** neto acumulado, 0 s frente a +N s.
  - **Tablas:** una por retraso y otra de markets con operaciones. Al hacer clic en un market se ve cada orden: precio de la señal, precio con retraso, tokens y USDC.

## Límites
- Solo se guarda el mejor bid/ask de cada segundo, no la profundidad. Una orden grande podría ejecutarse peor.
- La muestra de `T + 1 s` es la foto de ese segundo. La ejecución real puede caer entre dos fotos.
- Re-ejecutar el motor coincide con las operaciones guardadas en ~97 % de los markets. Las diferencias vienen de markets donde, en vivo, el price to beat llegó tarde: el replay ya lo conoce desde el principio.
