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
| Latencia al CLOB de Polymarket (cada 15 s, solo lectura) | Implementada | [latency.md](latency.md) |
| Replays del motor A con ejecución retrasada (0–3 s), página `/replays` | Implementada | [replays.md](replays.md) |
| Compras reales del motor A o C (interruptor por market y por fuente, proporcional o mínimo) | Implementada | [live-trading.md](live-trading.md) |
| Fuente futures (perpetuo USDⓈ-M) en paralelo a spot + comparativa `/compare` | Implementada | [futures-source.md](futures-source.md) |
| ETH como segundo activo (spot + futures, markets ETH Up/Down 5m) y página principal con BTC y ETH (rediseño claro/oscuro, bloques plegables, responsive) | Implementada | [eth-asset.md](eth-asset.md) |
| SS (Sol Strength): movimientos con fuerza de la P(Up) del motor C (variantes calibrada y base), con los tokens de BTC de referencia (solo informativo) | Implementada (hueco ETH = SOL de prueba) | [sol-strength.md](sol-strength.md) |
| Predict.fun BTC Up/Down 5m con los motores A y C (precio puntual, sin TWAP), mismo panel que Polymarket | **Desactivada** (código comentado, 2026-11-27) | [predict-markets.md](predict-markets.md) |

## Formato de un feature doc
`# Nombre` · **Estado** · **Objetivo** · **Servidor** (archivos/flujo) · **Frontend** (archivos) · **Protocolo** (enlace a `protocol.md`) · **Pendiente / ideas**.
