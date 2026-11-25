# 0005 — Memoria de 15 minutos, relleno inicial por REST y compresión

- **Estado**: aceptada · 2026-11-24

## Contexto
La memoria era un buffer por **cantidad** (5000 trades ≈ 5 min en BTC, variable según actividad) y 10 min de heatmap. El CVD, el footprint y las señales necesitan historia homogénea, y un reinicio del servidor no debe dejarlos vacíos.

## Decisión
- **Retención por tiempo**, no por cantidad: `RETENTION_MS` (default **15 min**) gobierna trades, columnas del heatmap (`DEPTH_HISTORY` se deriva) y puntos de CVD (1/s). `TRADES_MAX` (100 000) es solo un tope de seguridad.
- El footprint y las señales tienen su propia memoria (`BAR_HISTORY`, 60 barras = 1 h) porque son pocos datos y las divergencias de CVD necesitan contexto.
- **Relleno al arrancar** (`BACKFILL=true`): se descargan por REST `/aggTrades` los últimos `RETENTION_MS` (paginando por `fromId`, 1000 por página) y se pasan por la misma tubería que el vivo. El WebSocket vivo se abre antes y se bufferiza; al terminar el relleno se vuelca deduplicando por `aggId`. El servidor no emite a clientes hasta `ready`.
- El **heatmap no se puede rellenar** (Binance no ofrece libro histórico): tras un reinicio se reconstruye en vivo.
- Cada snapshot incluye `retentionMs`; el cliente poda por tiempo en lugar de por cantidad.
- **Compresión**: `permessage-deflate` en los WebSockets con umbral de 1 KB, para que los snapshots grandes viajen comprimidos sin gastar CPU en los deltas.
- La gráfica añade la ventana de **15 m**; con muchas burbujas dibuja solo las ~2500 de mayor volumen.

## Consecuencias
- Medido en desarrollo (BTCUSDT spot, mercado tranquilo): ~4 400 trades, 900 columnas de heatmap, 900 puntos de CVD, 17 barras en 15 min; snapshot de orderflow ≈ 78 KB sin comprimir. En horas de mucha actividad los trades pueden ser 5-10× más.
- **Subir la memoria** (p. ej. a 1 h): `RETENTION_MS=3600000`. El coste crece lineal: trades, heatmap (~0,8 KB/columna) y CVD. Revisar `TRADES_MAX`, el tamaño del snapshot y el coste de redibujar en el cliente (el heatmap ya se submuestrea cuando hay más columnas que píxeles). Más allá de ~1-2 h conviene pasar el histórico a agregados (velas/footprint) y no enviar trades crudos.
- El REST de Binance tiene límites de peso; 15 min ≈ 5-10 peticiones. Con memorias muy largas habría que espaciar o limitar el relleno.
- Si el relleno falla a medias, el servidor continúa con lo obtenido y el vivo.
