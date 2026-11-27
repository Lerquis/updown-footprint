# 0014 — Compras reales siguiendo al motor C

- **Estado**: aceptada · 2026-11-27

## Contexto
Con la sonda de latencia ([latency](../features/latency.md)) ya sabemos lo que tarda `POST /order` (~30 ms desde Railway), pero no lo que pasa con una orden real: cuánto se ejecuta, a qué precio y cuánto tiempo pasa desde la señal. El usuario quiere comprobarlo con dinero real, en pequeño y solo cuando él lo active.

## Decisión
- **Solo el motor C** (T + 150 ms, datos "a fecha"), solo el market en curso, con un interruptor en la web protegido por contraseña (`TRADING_PASSWORD`). Se apaga solo al terminar el market.
- **Importe:** paper ÷ 5, que pasa del rango del motor (5..50) a **1..10 USDC**. Se sube al mínimo de Polymarket (5 tokens) para que siempre se pueda vender. Tope de 40 USDC por market.
- **Orden FAK.** Lo que no llena al instante se cancela, así que nunca queda una orden en el libro. Empezó con límite señal ± 2¢; el 27 nov se quitó por defecto (`PM_LIVE_SLIPPAGE` 1), porque con 2¢ ninguna compra llegó a tiempo (ver [live-trading](../features/live-trading.md#latencia-real-27-nov-railway-amsterdam)).
- **Firma local con `OrderBuilder`** (`@polymarket/clob-client-v2` + `viem`), sin llamadas de red: tick 0.01, `negRisk` false y versión 2 son fijos para BTC 5m.
  - El envío va por `ClobH2` propio y no por el cliente HTTP de la librería (axios/HTTP 1.1, más lento).
  - La clave debe ser la de `PM_SIGNER_ADDRESS`; si no, todo queda desactivado.
- **En memoria,** sin guardar en la base todavía. Canal `/ws/trading`.

## Alternativas descartadas
- **`createAndPostMarketOrder` de la librería:** pide el libro por REST, resuelve la versión y usa HTTP/1.1. Añade una o dos idas y vueltas y más variación.
- **Orden FOK sin tolerancia:** muchas señales no se ejecutarían y no mediríamos la distancia real.

## Consecuencias
- El servidor puede tener una clave privada con fondos. La exposición está acotada por los topes (10 por orden, 40 por market, solo motor C, solo con el interruptor) y por la contraseña. Con "testing" la contraseña es débil: cambiarla en Railway si la web se comparte.
- La sonda de latencia sigue firmada con ceros e independiente de la clave.
