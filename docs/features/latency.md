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
- La barrera es la firma. El servidor no tiene private key (no hay ninguna variable que la lea), así que no puede producir una firma válida. El precio límite NO es una barrera: al final de un market el lado perdedor puede tener asks a 0.01.
- Prueba unitaria (`latency.test.ts`) que fija la firma a ceros.
- Salvaguarda: si Polymarket respondiera alguna vez 2xx, la sonda se desactiva para siempre y lo registra con `console.error`.
- Sin proxy wallet o sin market en curso, envía `{}` (se rechaza antes, en la validación).

La respuesta de Polymarket va en `detail` y el panel la muestra bajo la sonda.

El servidor ya recibe el libro de los tokens por WebSocket (`BookClient`), así que un bot propio pasaría el precio y se ahorraría el paso 1: `book` se muestra solo como referencia. `estimateMs = prepMs + order` (o `auth`, o `ping` si fallan) = una orden con la conexión ya abierta. `prepMs` = armar el cuerpo + HMAC (~0.1 ms). **No incluye** la firma EIP-712 real (~ms) ni el matching de Polymarket. El panel desglosa: red (`edge`) · Polymarket (`order − edge`) · preparar.

Medido en local (Costa Rica, 2026-11-26): `edge` 76 ms (Cloudflare Miami), `order` ~202 ms (~222 ms antes con HTTP/1.1), `connect` 350–570 ms, `prepMs` 0.1 ms.

Retraso de matching: algunos markets responden `status: "delayed"` y casan tras `seconds_delay` segundos (campo de `GET /markets/<conditionId>`). En BTC Up/Down 5m es **0** (comprobado 2026-11-26), así que la orden de mercado casa en la misma petición. Si cambiara, habría que sumarlo a la estimación. Restricciones del market (Gamma/CLOB): tick 0.01, mínimo 5 shares, `neg_risk: false`, libro sin `version` (CTF: dominio EIP-712 versión `"2"`), comisión solo para taker (`feeSchedule.rate` 0.05). Las órdenes de mercado son FAK/FOK con `expiration: "0"`.

`auth` y `order` necesitan `PM_SIGNER_ADDRESS` (EOA que creó la API key: **Signer Address** en polymarket.com → Settings → API keys). Sin ella responden 401 (`missing address header`). La UI lo avisa.

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
