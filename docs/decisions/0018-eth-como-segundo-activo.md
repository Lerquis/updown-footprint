# 0018 — ETH como segundo activo (clon completo de BTC)

- **Estado**: aceptada · 2026-11-27

## Contexto
Todo el sistema seguía BTC: Binance BTCUSDT (spot y futures, ADR 0016), los markets BTC Up/Down 5m de Polymarket y el Chainlink BTC/USD. Polymarket tiene los mismos markets de 5 min para ETH (`eth-updown-5m-<inicio>`), con su TWAP de Chainlink ETH/USD. Se quiere el mismo sistema con ETH y verlo en la misma página que BTC.

## Decisión
- **Un activo más encima de la fuente.** `MarketAsset` (`btc` | `eth`) en el protocolo. Cada activo tiene sus dos fuentes, así que el servidor crea hasta cuatro `createSource()`: BTC spot, BTC futures, ETH spot y ETH futures. Nada se mezcla entre activos.
- **Rutas.** BTC conserva las suyas (`/ws/x`, `/ws/futures/x`). ETH va con `/eth` delante de la fuente: `/ws/eth/x`, `/ws/eth/futures/x`, `/api/eth/markets`, `/api/eth/futures/trading/arm`. `sourcePath(source, path, asset)` las construye y `splitSource()` las deshace. Los mensajes no cambian.
- **Lo que cambia entre activos** (`AssetMarket` en `source.ts`): símbolo de Binance, símbolo de la API crypto-price y prefijo del slug de Polymarket, y los tamaños de precio/volumen (bucket del heatmap y nivel del footprint 0.05 USDT, desequilibrio mínimo 1.5 ETH: lo mismo, en proporción, que BTC con 1 USDT y 0.05 BTC).
- **Lo que NO cambia:** motores, estrategia, comisiones, calibración de la deriva y compras reales usan los mismos parámetros. El modelo trabaja con rendimientos relativos al precio, así que vale para los dos.
- **Chainlink por activo:** otro cliente (`price.crypto.twap` con `ethusd`, o `eth/usd` del RTDS sin credenciales). La latencia al CLOB sigue siendo una sola, compartida.
- **Bases y backups propios:** `polymarket-eth-v2.db` y `polymarket-eth-futures-v2.db` junto a la de BTC; backups en `updown-eth/v2/` y `updown-eth-futures/v2/`. Las bases de BTC no se tocan.
- **Compras reales:** disponibles en las cuatro fuentes, cada una con su interruptor, misma cartera y contraseña. Con todas activadas, la exposición máxima por ventana de 5 min se multiplica.
- `ETH_ENABLED` (por defecto sí) apaga ETH entero; `FUTURES_ENABLED` apaga los futures de los dos activos.
- `/api/compare?asset=eth` compara spot vs futures de ETH; `/compare?asset=eth` en la web.

## Alternativas descartadas
- **Activo como parámetro de cada canal** (un solo canal con mensajes etiquetados por activo): cambia todos los mensajes y obliga a filtrar en el cliente. Con rutas separadas los hooks y componentes no cambian.
- **Segundo servidor con `SYMBOL=ethusdt`:** dos despliegues y dos webs; se quiere todo en una página.

## Consecuencias
- El doble de conexiones a Binance y Polymarket, de CPU de motores y de memoria que con solo BTC.
- **Volumen:** dos bases más. ETH tiene menos aggTrades que BTC, pero hay que vigilar el tamaño del volumen de Railway y el espacio libre que necesita el backup.
- Replays (`npm run replays`) y calibración siguen leyendo solo la base de BTC spot.
- El log del tracker (`[polymarket] market …`) no lleva el prefijo del activo; el slug lo identifica.
