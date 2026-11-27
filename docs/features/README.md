# Features

| Feature | Estado | Doc |
|---|---|---|
| Feed de AggTrades de Binance | Implementada | [aggtrades-feed.md](aggtrades-feed.md) |
| Gráfica Bookmap (heatmap + burbujas, zoom) | Implementada | [heatmap-bookmap.md](heatmap-bookmap.md) |
| Footprint, CVD y señales (apilados, absorción, agotamiento, divergencias) | Implementada | [orderflow-signals.md](orderflow-signals.md) |
| Monitor de escenarios | Implementada (ya no se muestra en el dashboard; lo reemplaza el motor de señales) | [scenario-monitor.md](scenario-monitor.md) |
| Motor de señales de compra/venta Up/Down 5m + base de datos de markets | Implementada | [signal-engine.md](signal-engine.md) |
| Markets Polymarket BTC Up/Down 5m (en vivo + historial) | Implementada | [polymarket-markets.md](polymarket-markets.md) |
| Motores A y C (cronometrados, guardados; B eliminado) y drawer de decisiones | Implementada | [engines.md](engines.md) |
| Motores D (predictivo, taker con límite) y E (libro, maker), papel con latencia y cola reales | Implementada (solo papel; D se puede seguir con compras reales) | [predictive-engines.md](predictive-engines.md) |
| Latencia al CLOB de Polymarket (cada 15 s, solo lectura) | Implementada | [latency.md](latency.md) |
| Replays del motor A con ejecución retrasada (0–3 s), página `/replays` | Implementada | [replays.md](replays.md) |
| Compras reales del motor A, C o D (interruptor por market y por fuente, proporcional o mínimo) | Implementada | [live-trading.md](live-trading.md) |
| Fuente futures (perpetuo USDⓈ-M) en paralelo a spot + comparativa `/compare` | Implementada | [futures-source.md](futures-source.md) |

## Formato de un feature doc
`# Nombre` · **Estado** · **Objetivo** · **Servidor** (archivos/flujo) · **Frontend** (archivos) · **Protocolo** (enlace a `protocol.md`) · **Pendiente / ideas**.
