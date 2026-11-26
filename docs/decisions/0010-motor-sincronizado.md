# 0010 — Motor B sincronizado con el reloj de Binance, en paralelo al motor A

- **Estado**: aceptada · 2026-11-25

## Contexto
El mismo motor en dos servidores (PC y Railway) generaba operaciones distintas: cada uno tomaba la foto de 1 s en un instante distinto de su reloj interno, y las decisiones por umbral, encadenadas por la posición, amplifican diferencias de un tick. El usuario quiere conservar intacta la versión actual (rama `v1-personal-pc-overpowered`) y comparar en vivo con una versión que tienda a dar las mismas órdenes en cualquier servidor.

## Decisión
- Mantener el motor A sin cambios de lógica (verificado: salida idéntica en los 225 markets guardados) y como único que se guarda.
- Añadir un motor B con las mismas reglas que decide en el segundo exacto de Binance (+300 ms) con datos "a fecha" de ese segundo, usando la marca de tiempo de cada mensaje de Polymarket y de Chainlink, y un CVD propio por tiempo de trade.
- B no se persiste. Las decisiones de ambos motores se publican en un canal aparte (`/ws/engines`), que el frontend abre solo bajo demanda.
- Registrar el porqué de cada decisión (`PmDecision`) sin tocar el flujo de decisión.

## Consecuencias
- Se puede medir en vivo cuánto difieren A y B (y dos servidores con B) antes de decidir cuál se guarda en una futura `ENGINE_VERSION` 2.
- La latencia sigue importando para los datos que lleguen tarde (más de 300 ms).
- `SignalEngine.step` devuelve además `decision`. `BookClient` emite la marca de tiempo de Polymarket.
