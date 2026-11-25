# 0007 — Polymarket consumido y archivado en el servidor

- **Estado**: aceptada · 2026-11-24

## Contexto
Se quiere ver el market BTC Up/Down 5m en curso y revisar los anteriores junto al flujo de Binance. Todos los usuarios deben ver lo mismo y el navegador no habla con terceros (regla 1).

## Decisión
- Un `PolymarketTracker` en el servidor es el único consumidor de Polymarket (libro de tokens y Chainlink por WS, REST Gamma y `past-results`) y publica por `/ws/polymarket`.
- La ventana de cada market se calcula con el **reloj de Binance** (`ExchangeClock`), no con `Date.now()`; así coincide con las barras de footprint (barra de 1 min alineada a 5 min).
- Cada market terminado se archiva como `PmRecord` que **copia** los datos de Binance de su ventana: la memoria rodante de 15 min seguiría borrándolos.
- Solo memoria por ahora (`PM_HISTORY` markets); la persistencia en base de datos se decide luego.
- Se guardan los precios de los tokens Up/Down, el precio de Chainlink y el flujo de Binance. El price to beat y el cierre se piden a `crypto-price` **con TWAP de 60 s** (así resuelve Polymarket; el spot puede contradecir el resultado) y el % se calcula con ellos. El resultado sale siempre de `outcomesBySlug` (`past-results`); si no cuadrara con apertura/cierre, la UI avisa con ⚠. El resultado sale de `past-results` (fuente oficial), nunca se calcula.

- El precio de Chainlink en vivo es el **TWAP de 60 s** por PolyBolt (autenticado con credenciales CLOB del usuario, solo en `.env.local`); sin credenciales se usa el spot del RTDS antiguo. Las credenciales nunca se escriben en el repo, la doc ni los logs.

## Consecuencias
- Reiniciar el servidor pierde el historial. El footprint de un market solo está completo si el servidor lo vivió (o entra en el relleno de 15 min).
- El resultado oficial tarda unos minutos en publicarse; hasta entonces el market figura como *resolviendo*.
- Un cliente de libro por market (se reconecta cada 5 min); pre-suscribir al siguiente es una mejora posible.
