# ETH: segundo activo y página principal con los dos

**Estado:** implementada (27 nov). Decisiones: [ADR 0018](../decisions/0018-eth-como-segundo-activo.md) (servidor) y [ADR 0019](../decisions/0019-rediseno-claro-oscuro-acordeones.md) (rediseño).

## Objetivo
El mismo sistema que BTC (orderflow de Binance spot y futures, motores A/C/D/E, markets Up/Down 5m de Polymarket, base, backups, compras reales, comparativa) con ETH, visto en la misma página que BTC.

## Servidor
- `config.eth` (`config.ts`): símbolos, Chainlink, tamaños de precio/volumen, bases y prefijos de backup de ETH. Variables en [development](../guides/development.md).
- `source.ts`: `SourceOptions.asset` + `market: AssetMarket` (lo que cambia entre activos). `sourceLabel(asset, source)` es la clave de la fuente y el prefijo de sus logs (`[eth:binance]`, `[eth-futures:depth]`). `splitSource()` devuelve activo, fuente y ruta (prueba en `compare.test.ts`).
- `index.ts`: Chainlink ETH (`eth:chainlink-twap`), fuentes `eth` y `eth-futures`, `/health` → `eth: { spot, futures }`, `/api/compare?asset=eth`.

## Frontend
- `lib/source.tsx`: `SourceProvider asset source`, `useAsset()`, `ASSET_INFO` (nombre, par, símbolo). `useWsChannel`/`useApiUrl` añaden activo y fuente a la ruta; los hooks no cambian. La fuente se recuerda por activo (`updown.source`, `updown.source.eth`).
- `MarketDashboard.tsx`: `HomeDashboard` (página) → un `AssetDashboard` por activo (`SourceProvider` + remontaje al cambiar de fuente) → cabecera del activo (precio, selector de fuente, estados, enlace a la comparativa) y sus bloques plegables.
- Textos por activo: `VENUES[x].title(ticker)` y `chainlinkLabel(ticker)` (`lib/venue.ts`).
- `/compare?asset=btc|eth` con selector de activo.

## Protocolo
`MarketAsset`, `ASSETS` y `sourcePath(source, path, asset)`: ver [protocol.md](../architecture/protocol.md#activos-y-fuentes).

## Prueba con Solana (27-28 nov)
- El hueco "ETH" consume SOL (`config.eth`; los valores de ETH están en el comentario "PRUEBA").
- Polymarket solo publica `past-results` de 5 min para BTC. El resultado de SOL sale de Gamma (`gammaOutcome` en `polymarket/api.ts`).
- En la web solo se grafica el motor C (`ASSET_INFO.eth.charts`), con SS en dos variantes y los tokens de BTC de referencia ([sol-strength](sol-strength.md)).

## Pendiente / ideas
- Calibrar la deriva (D/E) con datos de ETH.
- Replays con la base de ETH.
