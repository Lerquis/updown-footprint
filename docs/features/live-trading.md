# Compras reales del motor C

**Estado**: Implementada (requiere `PM_WALLET_PRIVATE_KEY` y `TRADING_PASSWORD` en el servidor).

**Objetivo**: ejecutar con dinero real las compras y ventas que señala el motor C, solo cuando el usuario lo activa y solo en el market en curso. Sirve para medir de verdad cuánto tarda una orden y cuánta distancia hay (en tiempo y en precio) entre la señal y la ejecución. Decisión: [ADR 0014](../decisions/0014-compras-reales-motor-c.md).

## Reglas
| Regla | Valor |
|---|---|
| Quién dispara | Solo las señales del **motor C** (`TimedEngine` c, T + 150 ms) |
| Cuándo | Solo con el interruptor activado, solo en el **market en curso**. Se apaga solo al cambiar de market y al reiniciar el servidor |
| Importe de compra | Paper ÷ 5 (`PM_LIVE_SCALE` 0.2): paper 5..50 → **1..10 USDC** (`PM_LIVE_MIN_USD`/`MAX_USD`) |
| Mínimo de Polymarket | Se sube a `max(1 USDC, 5 tokens × precio límite)` para poder venderlo después. Si no cabe en 10 USDC o en el tope del market, se omite |
| Tope por market | 40 USDC en compras (`PM_LIVE_MAX_MARKET_USD`) |
| Venta | Vende **todos** los tokens reales de ese lado (de las ejecuciones). Sin tokens reales: omitida |
| Orden | **FAK** (llena lo que puede al instante y cancela el resto) con **precio límite**: compra ≤ señal + 2¢, venta ≥ señal − 2¢ (`PM_LIVE_SLIPPAGE`), redondeado al tick 0.01. Polymarket hace cumplir el límite |
| Fin del market | No se vende: Polymarket liquida los tokens ganadores (1 USDC) automáticamente |

## Flujo
1. El motor C emite `PmSignal` en su paso (`index.ts`: `engines3.c.on("step")` → `liveTrader.onSignals`).
2. `LiveTrader` (`apps/server/src/polymarket/liveTrader.ts`) pone las órdenes en cola, en serie y en orden. Calcula el límite (`limitPriceFor`) y el importe (`realBuyUsd`).
3. **Firma local** con `OrderBuilder` de `@polymarket/clob-client-v2` (EIP-712, `signatureType` 1 POLY_PROXY, maker = proxy wallet). Sin llamadas de red, ~5 ms.
4. **Envío** por su propia conexión HTTP/2 caliente (`ClobH2`) con cabeceras L2 ([ADR 0012](../decisions/0012-conexion-http2-caliente-al-clob.md)).
5. La respuesta (`makingAmount`/`takingAmount`) se lee con `evaluateFill`: tokens, USDC, precio medio y deslizamiento. Se actualiza la posición real y se emite `LiveTrade`.

Tiempos en cada `LiveTrade` (reloj de Binance): `signalTime` (segundo en que decidió el motor), `sentAt`, `respondedAt`, `latencyMs` (ida y vuelta de `POST /order`) y `signMs` (firma).

## Seguridad
- **Sin clave o sin contraseña: desactivado.** Si la clave no es la de `PM_SIGNER_ADDRESS`, también queda desactivado. `/ws/trading` informa el motivo.
- **Interruptor protegido:** `POST /api/trading/arm` exige la cabecera `x-trading-password`, comparada en tiempo constante. Una contraseña incorrecta tarda 800 ms y se registra. La web la guarda en `localStorage` de ese navegador.
- **Topes duros:** 10 USDC por orden y 40 USDC por market. Solo el motor C, solo el market en curso.
- **La sonda de latencia no cambia:** sigue firmada con ceros (`PROBE_SIGNATURE`, [latency](latency.md)). La clave solo la usa `LiveTrader`.
- **Secretos:** `PM_WALLET_PRIVATE_KEY` y `TRADING_PASSWORD` solo en `apps/server/.env.local` y en las variables de Railway.

## Frontend
- `apps/web/lib/useTrading.ts`: canal `/ws/trading` y `setArmed()` (POST con la contraseña guardada).
- `components/LiveTradingCard.tsx` (en `PolymarketPanel`, market en curso):
  - interruptor y aviso "ACTIVO · dinero real";
  - posición y gasto;
  - tabla de operaciones: precio de la señal, límite, precio real, deslizamiento, tokens/USDC, señal→respuesta, orden (ms) y estado;
  - medias de latencia, señal→respuesta y deslizamiento.
- `PolymarketChart`: en la sección del motor C, cada ejecución real es un **círculo amarillo** en (respuesta, precio real), unido con una línea a la señal.

## Protocolo
[`/ws/trading`](../architecture/protocol.md#canal-wstrading-compras-reales-del-motor-c) y `POST /api/trading/arm`.

## Pendiente / ideas
- Guardar las operaciones reales en la base (ahora viven en memoria; se pierden al reiniciar).
- Tras `delayed`, seguir la orden hasta que case (no pasa en BTC 5m: `seconds_delay` 0).
- Leer el saldo real antes de comprar (`not enough balance` hoy se registra como rechazada).
