# Gráfica estilo Bookmap (heatmap + burbujas)

**Estado**: implementada (2026-11-24); verificada visualmente en el navegador.

**Objetivo**: ver en una sola gráfica precio vs tiempo, la liquidez del libro de órdenes (heatmap) y los trades (burbujas por USD).

## Servidor
Canal `/ws/depth` — ver [ADR 0004](../decisions/0004-libro-local-y-heatmap.md) y [protocol.md](../architecture/protocol.md#canal-wsdepth). Archivos: `binance/depthClient.ts`, `store/orderBook.ts`, `store/depthHistory.ts` y el `Channel` genérico (`ws/channel.ts`) montado en `index.ts`.

## Frontend
- `components/BookmapChart.tsx`: canvas. El heatmap se pinta en un canvas offscreen (como mucho cada 100 ms) y entre repintados se desplaza la imagen; escala de color por percentil 97 de las celdas visibles con raíz cuadrada, paleta negro→azul→cian→amarillo→blanco. Burbujas, línea de precio y último precio se dibujan cada frame, recortados al área de trazado.
- **Colores por lado** (`lib/heatmapPalette.ts`, única fuente para canvas y leyenda): verde = liquidez de compra (buckets por debajo del `mid` de la columna), rojo = liquidez de venta (por encima). Más brillante = más liquidez; casi blanco = zona caliente.
- **Rótulos "Zona caliente de compra/venta"**: en la última columna se busca la pared mayor de cada lado y, si supera la referencia de color (p97 visible), se rotula con su valor aproximado en USD.
- `components/HeatmapLegend.tsx` (escalas de color, visible con el heatmap activo) y `components/HeatmapHelp.tsx` (botón "?" → Dialog shadcn que explica ejes, colores, zonas calientes, burbujas e interpretación). **Si cambia la lógica de colores o rótulos, actualizar el texto del modal.**
- `components/MarketDashboard.tsx`: Cards, switches (Heatmap/Burbujas) y ToggleGroup de ventana (30s/1m/5m/15m), switch de Señales y botón *Restablecer vista* con shadcn.
- `lib/exchangeClock.ts`: alinea el eje de tiempo con el reloj de Binance (el del PC puede estar desfasado segundos; se detectó 16 s en desarrollo).

## Zoom y desplazamiento
`lib/chartView.ts` (`ChartView`) guarda el estado de la vista **fuera de React** y lo comparten `BookmapChart` y `CvdChart` (mismo eje de tiempo); `lib/chartInteractions.ts` conecta el ratón.
- **Rueda**: zoom del tiempo anclado bajo el cursor (se queda *en vivo* si el borde derecho queda cerca del presente). **Ctrl/Shift + rueda** o rueda sobre el eje derecho: zoom del precio (solo gráfica de precio). **Arrastrar**: mover en tiempo (y precio). **Doble clic** o botón: restablecer.
- Fuera de "en vivo" se muestra *Vista histórica* y se ocultan las etiquetas de zona caliente y la línea de último precio.
- Rendimiento con 15 min: el heatmap se submuestrea si hay más columnas que píxeles y las burbujas se limitan a las ~2500 de mayor volumen (umbral recalculado 2×/s).
- Las señales de orderflow se dibujan sobre esta gráfica: ver [orderflow-signals.md](orderflow-signals.md).

## Pendiente / ideas
- Hover/crosshair con precio, liquidez y USD.
- Escala de color ajustable; mostrar bids/asks por separado; footprint por velas.
- Si el heatmap crece (más rango o ventana), mover el pintado a WebGL u OffscreenCanvas en worker.
