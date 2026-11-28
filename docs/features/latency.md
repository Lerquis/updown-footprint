# Latencia a Polymarket

**Estado**: Implementada.

**Objetivo**: saber aproximadamente cuánto tardaría una compra/venta enviada desde el servidor al CLOB de Polymarket, sin operar nunca (no hay private key: no se puede firmar ninguna orden). Se mide en el servidor (no en el navegador: la orden la enviaría el servidor) cada 15 s.

## Cómo se opera de verdad (referencia: proyecto copytrade-polymarket)
`createAndPostMarketOrder` de `@polymarket/clob-client-v2` (en `realTradingService.ts`):
1. `GET /book?token_id=…` para calcular el precio de la orden de mercado, **solo si no se le pasa `price`** (`if (!userMarketOrder.price)` en `createMarketOrder`). El precio no es un campo de `POST /order`: va implícito en `makerAmount`/`takerAmount` (precio límite = peor precio aceptado en una FOK). Tick size, neg-risk y comisión se piden una vez y quedan en caché.
2. Firma EIP-712 local con la private key de la EOA (`signatureType: 1`, `funderAddress` = proxy wallet). Unos ms, sin red.
3. `POST /order` con cabeceras L2 (`POLY_ADDRESS`, `POLY_SIGNATURE` = HMAC-SHA256 del secret, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`).

## Qué se mide (por ronda, en serie)
Todo salvo `connect` va por **una conexión HTTP/2 persistente y siempre caliente** (`ClobH2`): la que usaría un bot. Se reabre en cuanto se cae y se mantiene viva con un PING cada `PM_LATENCY_KEEPALIVE_MS`. Ver [ADR 0012](../decisions/0012-conexion-http2-caliente-al-clob.md).

| Sonda | Petición | Qué representa |
|---|---|---|
| `connect` | `GET /time` con conexión nueva (HTTP/1.1) | DNS + TCP + TLS + ida y vuelta: coste si no hubiera conexión abierta (diagnóstico) |
| `edge` | PING de HTTP/2 | Lo responde el borde de Cloudflare: red pura, sin Polymarket |
| `ping` | `GET /time` | Red + Cloudflare ↔ servidores de Polymarket |
| `book` | `GET /book` del token Up del market en curso | Paso 1 |
| `auth` | `GET /balance-allowance` con cabeceras L2 | Mismo gateway y autenticación que `POST /order` |
| `order` | `POST /order` con una **orden completa firmada con ceros** | Paso 3: el endpoint real con una orden real (ver abajo). Polymarket la rechaza al verificar la firma |

### La orden de prueba (`buildProbeOrder`)
Compra FOK de 1 USDC a precio límite 0.01 (100 shares) del token Up del market en curso; `maker` = proxy wallet (`PM_FUNDER_ADDRESS`), `signer` = `PM_SIGNER_ADDRESS`, `signatureType: 1` (POLY_PROXY), `owner` = API key, `expiration: "0"`. Todo es real salvo `signature`: 65 bytes a cero.

Polymarket valida en orden y la rechaza en el último paso antes del matching (comprobado 2026-11-26):
1. Autenticación L2 → sin `PM_SIGNER_ADDRESS`: 401.
2. `maker` → si no es la proxy wallet: 400 `maker address not allowed`.
3. Monto → menos de 1 USDC: 400 `invalid amount for a marketable BUY order`.
4. **Firma → 400 `invalid POLY_PROXY signature`** ← aquí se detiene siempre.

**Garantías de que nunca compra**:
- La barrera es la firma: la orden de prueba lleva siempre `PROBE_SIGNATURE` (ceros) y no pasa por ningún firmante. La clave privada (`PM_WALLET_PRIVATE_KEY`, si está) solo la usa `LiveTrader` para las compras reales del motor C con el interruptor activado ([live-trading](live-trading.md)). El precio límite NO es una barrera: al final de un market el lado perdedor puede tener asks a 0.01.
- Prueba unitaria (`latency.test.ts`) que fija la firma a ceros.
- Salvaguarda: si Polymarket respondiera alguna vez 2xx, la sonda se desactiva para siempre y lo registra con `console.error`.
- Sin proxy wallet o sin market en curso, envía `{}` (se rechaza antes, en la validación).

La respuesta de Polymarket va en `detail` y el panel la muestra bajo la sonda.

El servidor ya recibe el libro de los tokens por WebSocket (`BookClient`), así que un bot propio pasaría el precio y se ahorraría el paso 1: `book` se muestra solo como referencia. `estimateMs = prepMs + order` (o `auth`, o `ping` si fallan) = una orden con la conexión ya abierta. `prepMs` = armar el cuerpo + HMAC (~0.1 ms). **No incluye** la firma EIP-712 real (~ms) ni el matching de Polymarket. El panel desglosa: red (`edge`) · Polymarket (`order − edge`) · preparar.

Medido en local (Costa Rica, 2026-11-26): `edge` 76 ms (Cloudflare Miami), `order` ~202 ms (~222 ms antes con HTTP/1.1), `connect` 350–570 ms, `prepMs` 0.1 ms.

Retraso de matching: algunos markets responden `status: "delayed"` y casan tras `seconds_delay` segundos (campo de `GET /markets/<conditionId>`). En BTC Up/Down 5m es **0** (comprobado 2026-11-26), así que la orden de mercado casa en la misma petición. Si cambiara, habría que sumarlo a la estimación. Restricciones del market (Gamma/CLOB): tick 0.01, mínimo 5 shares, `neg_risk: false`, libro sin `version` (CTF: dominio EIP-712 versión `"2"`), comisión solo para taker (`feeSchedule.rate` 0.05). Las órdenes de mercado son FAK/FOK con `expiration: "0"`.

`auth` y `order` necesitan `PM_SIGNER_ADDRESS` (EOA que creó la API key: **Signer Address** en polymarket.com → Settings → API keys). Sin ella responden 401 (`missing address header`). La UI lo avisa.

## Check maker: órdenes límite reales
La sonda de arriba mide una orden que **compra al instante** (taker), que además Polymarket retiene antes de ejecutar. Las órdenes **límite en reposo** (maker) no casan al llegar y no pasan por esa retención. El check mide ese ciclo con **órdenes reales y pequeñas** que siguen las señales del motor elegido (A o C) y **se activa a mano**.

**Cada señal del motor:**
- **Compra:** compra post-only a **mejor bid + 1 tick**, primera de la fila en un nivel nuevo. Si el spread es de 1 tick, se une al mejor bid.
  - Importe: **máx(1 USDC, 5 tokens)**. Polymarket exige 5 tokens; a 0,60 son 3 USDC.
  - Se cancela a los **2 s** (`PM_MAKER_CHECK_REST_MS`) si no se llenó entera.
- **Venta:** lo mismo en el ask (mejor ask − 1 tick), con los tokens que el check compró en ese market (si hay al menos 5). Lo que no se vende lo liquida Polymarket al cierre.
- Un lado con una orden en curso no recibe otra: esa señal se omite.

**Qué mide** (desde el envío de cada petición):
1. `signMs` (firma) y `postMs` (ida y vuelta de `POST /order`; `status` = `live` si quedó en el libro, o el motivo del rechazo, p. ej. post-only que cruzaría).
2. `userAckMs`: evento `PLACEMENT` del canal de usuario. `exchangePlaceMs`: su marca de tiempo de Polymarket, solo si viene en ms; incluye el desfase entre relojes.
3. `bookMs`: aparece en el **libro público**. Es aproximado: un `price_change` de su nivel con su tamaño, y en niveles con mucho movimiento puede confundirse.
4. `firstFillMs` y `filledShares`: ejecuciones por el canal de usuario.
   - Fuentes: `size_matched` de los eventos de orden y `matched_amount` de los `trade` donde la orden está entre los `maker_orders`.
   - Cada trade se cuenta una vez, aunque llegue de nuevo como MINED/CONFIRMED.
5. Si no se llenó entera: `cancelMs` (`DELETE /order`), `userCancelMs` (`CANCELLATION`) y `bookGoneMs` (desaparece del libro).
   - Hasta `bookGoneMs` alguien podría ejecutarla: es el tiempo que importa para cancelar cuando la idea muere.
6. `status`: `filled` · `partial` · `unfilled` · `rejected` · `skipped` (no se envió, con el motivo) · `error`.

**Seguridad:**
- Apagado por defecto y al reiniciar. Se activa en la web con la contraseña de trading (`POST /api/latency/maker` `{ enabled, engine }`, cabecera `x-trading-password`).
- Se apaga solo tras `PM_MAKER_CHECK_MAX` (30) órdenes enviadas.
- Solo el market en curso; tope de compras por market `PM_LIVE_MAX_MARKET_USD` (40).
- Si una cancelación falla, reintenta. Si algo falla con una orden viva, la cancela o se apaga.
- Al apagar el servidor, cancela las órdenes vivas.
- Es independiente de las [compras reales](live-trading.md): si las dos están activas, cada una opera por su cuenta.

Código: `polymarket/makerProbe.ts` (`MakerProbe`, funciones puras `makerPrice`, `makerSize`, `orderEvent`, `makerFill`, `parsePost`, `parseCancel`; prueba en `makerProbe.test.ts`).
- Firma y cancela con `LiveTrader.postLimitOrder` (GTC post-only) y `LiveTrader.cancelOrder`, por su conexión HTTP/2 caliente.
- Los eventos del canal de usuario llegan por `LiveTrader` (evento `user`).

Web: `components/MakerProbeCard.tsx` en el panel de latencia, con interruptor, motor, gasto y tokens del market, medianas, órdenes ejecutadas y tabla por orden.

## Servidor
- `apps/server/src/polymarket/clobConnection.ts`: `ClobH2` (conexión HTTP/2 persistente, reconexión inmediata, `ping()`).
- `apps/server/src/polymarket/latency.ts`: `LatencyMonitor` (rondas por `ClobH2`, `connect` por HTTP/1.1 nuevo; keep-alive; historial de `PM_LATENCY_HISTORY` rondas), funciones puras `estimateOrderMs`, `l2Signature`, `l2Headers`, `buildProbeOrder`, `responseDetail` (prueba en `latency.test.ts`).
- `index.ts`: canal `/ws/latency`; `time` de cada ronda en el reloj de Binance. `/health` → `latency`.
- Variables: `PM_CLOB_URL`, `PM_SIGNER_ADDRESS`, `PM_FUNDER_ADDRESS` (proxy wallet; `gamma-api /public-profile?address=<signer>` → `proxyWallet`), `PM_LATENCY_INTERVAL_MS` (15000), `PM_LATENCY_KEEPALIVE_MS` (5000), `PM_LATENCY_HISTORY` (40). La región sale de `RAILWAY_REPLICA_REGION` (Railway) o `local`. Ver [development](../guides/development.md).

## Frontend
- `apps/web/lib/useLatency.ts` + `components/LatencyPanel.tsx`: orden estimada (verde < 250 ms, amarillo < 500, rojo) con su desglose, región ("Desde: …"), las seis sondas con su código HTTP si no es 200, reloj circular con la cuenta atrás hasta la siguiente medida y la hora de la última, mín/mediana/máx y minigráfica del historial.

## Protocolo
[`/ws/latency`](../architecture/protocol.md#canal-wslatency-latencia-a-polymarket).

## Pendiente / ideas
- Medir una orden firmada real (incluye matching): solo junto al trading real.
- Comparar regiones de Railway (Amsterdam vs. EE. UU.) con el panel y elegir la de menor `order`.
