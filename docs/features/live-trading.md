# Compras reales (motor A o C)

**Estado**: Implementada (requiere `PM_WALLET_PRIVATE_KEY` y `TRADING_PASSWORD` en el servidor).

**Objetivo**: ejecutar con dinero real las compras y ventas que señala el motor C, solo cuando el usuario lo activa y solo en el market en curso. Sirve para medir de verdad cuánto tarda una orden y cuánta distancia hay (en tiempo y en precio) entre la señal y la ejecución. Decisión: [ADR 0014](../decisions/0014-compras-reales-motor-c.md).

## Reglas
| Regla | Valor |
|---|---|
| Quién dispara | Las señales del motor elegido al activar: **A** (T + 0, lo antes posible) o **C** (T + 150 ms, por defecto) |
| Cuándo | Solo con el interruptor activado, solo en el **market en curso**. Se apaga solo al cambiar de market y al reiniciar el servidor |
| Fuente | Hay un interruptor **por fuente** (spot y futures, [futures-source](futures-source.md)), cada uno sigue a los motores de su fuente. Misma contraseña y misma cartera; el tope por market es de cada fuente, así que con las dos activadas la exposición máxima se duplica |
| Importe de compra | **Proporcional:** paper ÷ 5 (`PM_LIVE_SCALE` 0.2), es decir, paper 5..50 → **1..10 USDC** (`PM_LIVE_MIN_USD`/`MAX_USD`). **Mínimo:** lo menos que acepta Polymarket y se puede vender después, `max(1 USDC, 5 tokens × precio de la señal)`. Se elige al activar |
| Mínimo de Polymarket | Se sube a `max(1 USDC, 5 tokens × precio de la señal)` para poder venderlo después. Si no cabe en 10 USDC o en el tope del market, se omite |
| Tope por market | 40 USDC en compras (`PM_LIVE_MAX_MARKET_USD`) |
| Venta | Vende **todos** los tokens reales de ese lado (de las ejecuciones). Sin tokens reales: omitida |
| Orden | **FAK** (llena lo que puede al instante y cancela el resto). **A y C: sin límite de precio por defecto** (`PM_LIVE_SLIPPAGE` 1): compra hasta 0.99 y vende desde 0.01; lo que acota el riesgo es el importe en USDC. Con `PM_LIVE_SLIPPAGE=0.02` vuelve el límite señal ± 2¢, redondeado al tick 0.01. |
| Fin del market | No se vende: Polymarket liquida los tokens ganadores (1 USDC) automáticamente |

## Flujo
1. El motor elegido emite `PmSignal`: A y C en su paso (`engines3[id].on("step")`) → `liveTrader.onSignals`.
2. `LiveTrader` (`apps/server/src/polymarket/liveTrader.ts`) pone las órdenes en cola, en serie y en orden. Calcula el límite (`limitPriceFor`) y el importe (`realBuyUsd`).
3. **Firma local** con `OrderBuilder` de `@polymarket/clob-client-v2` (EIP-712, `signatureType` 1 POLY_PROXY, maker = proxy wallet). Sin llamadas de red, ~5 ms.
4. **Envío** por su propia conexión HTTP/2 caliente (`ClobH2`) con cabeceras L2 ([ADR 0012](../decisions/0012-conexion-http2-caliente-al-clob.md)).
5. La respuesta (`makingAmount`/`takingAmount`) se lee con `evaluateFill`: tokens, USDC, precio medio y deslizamiento. Se actualiza la posición real y se emite `LiveTrade`.

Tiempos en cada `LiveTrade`:
- En reloj de Binance: `signalTime` (segundo en que decidió el motor), `sentAt` y `respondedAt`.
- Duraciones: `latencyMs` (ida y vuelta de `POST /order`) y `signMs` (firma).
- En reloj de Polymarket: **`matchedAt`**, el instante de la ejecución. Llega por el **canal de usuario** (`wss://ws-subscriptions-clob.polymarket.com/ws/user`, `PM_USER_WS_URL`, autenticado con las credenciales CLOB, PING cada 10 s): evento `trade`, `taker_order_id` = nuestra `orderId`, `timestamp` en ms (`tradeEventMatch`). Suele llegar después de la respuesta HTTP; el servidor reenvía la operación con `matchedAt` y el cliente hace *upsert* por `signalId`. Si llega antes, se guarda hasta que llega la respuesta.

`matchedAt − signalTime` (señal → ejecución) es la medida que importa. `respondedAt − matchedAt` indica cuánto tarda Polymarket en responder después de ejecutar.

## Latencia real (27 nov, Railway Amsterdam)
Primeras 4 compras con límite ±2¢: todas `rejected` con "no orders found to match with FAK order". Se comprobó con los trades del market (Data API v2) que el precio subió 4–9¢ en menos de 1 s: otros compradores se llevaron a los vendedores baratos antes de que llegara nuestra orden. Por eso se quitó el límite.

| Tramo | Tiempo |
|---|---|
| Señal (segundo T) → orden enviada | ~152 ms (motor C decide en T + 150 ms; firma 2–5 ms) |
| `POST /order` ida y vuelta | 255–1707 ms (orden de prueba con firma de ceros: ~40 ms) |

**Retención de Polymarket (*taker delay*):** los markets cripto Up/Down retienen cada orden que casa al instante. Durante la retención la orden queda pendiente, no se puede cancelar, y luego se valida otra vez y se ejecuta. En BTC 5 min está activa: `GET /clob-markets/<conditionId>` → `itode: true`. La documentación dice 250 ms; según fuentes externas pasó a 50 ms y luego a 150 ms. Es el suelo de cualquier orden que compra o vende al instante, y no se puede evitar desde nuestro lado. El resto de la variación (hasta ~1,4 s) también es de Polymarket.

## Seguridad
- **Sin clave o sin contraseña: desactivado.** Si la clave no es la de `PM_SIGNER_ADDRESS`, también queda desactivado. `/ws/trading` informa el motivo.
- **Interruptor protegido:** `POST /api/trading/arm` exige la cabecera `x-trading-password`, comparada en tiempo constante. Una contraseña incorrecta tarda 800 ms y se registra. La web la guarda en `localStorage` de ese navegador.
- **Topes duros:** 10 USDC por orden y 40 USDC por market. Solo el motor elegido, solo el market en curso. Sin límite de precio (A y C), una compra puede ejecutarse muy por encima de la señal: el importe nunca supera esos topes.
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
[`/ws/trading`](../architecture/protocol.md#canal-wstrading-compras-reales-motor-a-c-o-d) y `POST /api/trading/arm`.

## Pendiente / ideas
- Guardar las operaciones reales en la base (ahora viven en memoria; se pierden al reiniciar).
- Tras `delayed`, seguir la orden hasta que case (no pasa en BTC 5m: `seconds_delay` 0).
- Leer el saldo real antes de comprar (`not enough balance` hoy se registra como rechazada).
