# Motores A y B (sincronizado) y drawer de decisiones

**Estado**: implementada · 2026-11-25 · Decisión: [ADR 0010](../decisions/0010-motor-sincronizado.md)

## Por qué
Dos servidores (PC local y Railway) con los mismos datos daban operaciones distintas en el mismo market. El motor decide con una "foto" por segundo, y cada servidor la sacaba en un instante distinto de su reloj interno (p. ej. x,47 s y x,66 s). El libro de Polymarket cambia muchas veces por segundo, y una diferencia de un tick bastaba para que uno vendiera y el otro no. Desde ahí las historias divergen, porque cada decisión depende de la posición.

## Qué hay
- **Motor A (principal)**: sin cambios de lógica. Muestrea con el `setInterval` de 1 s del servidor y **es el que se guarda en la base** (`ENGINE_VERSION` 1). Su salida es idéntica a la versión anterior: verificado repitiendo los 225 markets guardados con el código viejo y el nuevo.
- **Motor B (sincronizado, `polymarket/syncEngine.ts`)**: mismas reglas (`SignalEngine`) y mismos parámetros. Decide en cada segundo exacto `T` del reloj de Binance, `PM_SYNC_DELAY_MS` (300) después de que empiece el segundo siguiente, con datos **"a fecha" de `T`**:
  - libro Up/Down: el último mensaje con `timestamp` de Polymarket ≤ T (si un mensaje no trae marca de tiempo, se usa la hora de llegada);
  - Chainlink: el último precio con marca de tiempo ≤ T;
  - Binance: un CVD de 1 s propio (`SecondCvd`) construido solo con aggTrades de tiempo < T (igual que el del motor de orderflow, pero cerrado por el reloj y no por la llegada de trades); señales de footprint con tiempo ≤ T;
  - basis suavizado (EMA de 60 s) propio.

  Así dos servidores ven la misma foto, salvo datos que tarden más de 300 ms en llegar. **Solo vive en memoria**: no se guarda en la base (se repetirían los markets). Recuerda las operaciones de los últimos `PM_HISTORY` markets para compararlas.
- **Registro de decisiones** (`PmDecision`): cada segundo, cada motor anota las probabilidades (modelo, mercado y mezcla), los precios, la posición, el EV de comprar cada lado y de vender lo que tiene, y el **primer impedimento** por lado (`PmBlock`: EV bajo, espera, spread, calentando…). Es solo informativo y no cambia ninguna decisión.

## Consumo
- Servidor: un `SignalEngine` más por segundo y un CVD de 1 s, que es trivial. Las historias "a fecha" se podan a 60 s.
- Red: el canal `/ws/engines` ([protocolo](../architecture/protocol.md)) solo se abre desde la web con el drawer abierto o con "Motor B" activado en el gráfico. Sin clientes, el servidor no serializa nada. El snapshot del market en curso pesa ~10–200 KB sin comprimir (va con permessage-deflate). Los deltas son 2 por segundo.
- Base de datos: sin cambios.

## Frontend
- Botón **Motores** (cabecera del panel de Polymarket) → drawer (`EnginesDrawer`):
  - estado en vivo de A y B: P(Up) con la que decide, modelo y mercado, precios, posición, y "Comprar Up/Down" y "Vender" con su edge frente al umbral y el motivo;
  - línea de tiempo segundo a segundo del market en curso: amarillo fuerte = acción distinta, amarillo suave = misma acción con distinta evaluación; filtro "Solo diferencias";
  - markets recientes: operaciones y neto de papel de A y de B.
- Interruptor **Motor B**: dibuja las operaciones de B en el gráfico de probabilidad como triángulos huecos con prefijo "B", para compararlas con las de A (rellenos).
- Hook `useEngines(enabled)`: vuelca los deltas una vez por frame.

## Límites
- Un dato que tarde más de `PM_SYNC_DELAY_MS` en llegar puede verse en un servidor y no en otro. Subir el retraso lo reduce, a costa de decidir más tarde.
- B no se guarda: al reiniciar el servidor se pierde su historial.
- El modelo usa una volatilidad estimada con hasta 15 min de CVD: justo después de arrancar, dos servidores pueden diferir un poco hasta acumular esa historia.
