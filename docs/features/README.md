# Features

| Feature | Estado | Doc |
|---|---|---|
| Feed de AggTrades de Binance | Implementada | [aggtrades-feed.md](aggtrades-feed.md) |
| Gráfica Bookmap (heatmap + burbujas, zoom) | Implementada | [heatmap-bookmap.md](heatmap-bookmap.md) |
| Footprint, CVD y señales (apilados, absorción, agotamiento, divergencias) | Implementada | [orderflow-signals.md](orderflow-signals.md) |
| Monitor de escenarios | Implementada (ya no se muestra en el dashboard; lo reemplaza el motor de señales) | [scenario-monitor.md](scenario-monitor.md) |
| Motor de señales de compra/venta Up/Down 5m + base de datos de markets | Implementada | [signal-engine.md](signal-engine.md) |
| Markets Polymarket BTC Up/Down 5m (en vivo + historial) | Implementada | [polymarket-markets.md](polymarket-markets.md) |
| Motores A, B y C (cronometrados, los tres guardados) y drawer de decisiones | Implementada | [engines.md](engines.md) |

## Formato de un feature doc
`# Nombre` · **Estado** · **Objetivo** · **Servidor** (archivos/flujo) · **Frontend** (archivos) · **Protocolo** (enlace a `protocol.md`) · **Pendiente / ideas**.
