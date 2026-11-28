# apps/web

Next.js (App Router) + React 19 + TypeScript. Solo habla con nuestro servidor vía WebSocket (`NEXT_PUBLIC_WS_URL`).

## Estructura
- `app/` — rutas y layout (Server Components por defecto).
- `components/ui/` — shadcn/ui (generados, editables). `components/` — componentes de dominio; los que usan hooks llevan `"use client"`.
- `lib/source.tsx` — activo (BTC/ETH, ADR 0018) y fuente (spot/futures, ADR 0016) que ve un panel: `SourceProvider asset source`, `useAsset`, `useSource`, `ASSET_INFO`. `useWsChannel` y `useApiUrl` añaden activo y fuente a la ruta; los hooks NO los manejan. `MarketDashboard.tsx`: `HomeDashboard` (página) → `AssetDashboard` por activo, que remonta su panel al cambiar de fuente. `/compare?asset=` (`CompareView`, `useCompare`): comparativa spot vs futures por activo.
- Diseño (ADR 0019): `components/Panel.tsx` (bloque plegable, estado recordado por `id`; plegado desmonta el contenido, por eso los hooks viven en el panel del activo), `Segmented.tsx` (selector en pastillas), `AppHeader.tsx` (barra superior con tema). `lib/theme.tsx`: tema claro/oscuro (`THEME_SCRIPT` en `<head>`) y `useStored` (valor en `localStorage`). Fuentes Manrope + JetBrains Mono (`app/layout.tsx`); los canvas usan `chartMono()`.
- `lib/useWsChannel.ts` — conexión WS genérica con reconexión. `lib/use<Canal>.ts` — un hook por canal sobre `useWsChannel`: estado + datos.
- `lib/chartView.ts` + `chartInteractions.ts` — vista (zoom/desplazamiento) **compartida** por los canvas de precio y CVD; vive fuera de React.
- `lib/exchangeClock.ts` — reloj de Binance estimado; usarlo (no `Date.now()`) para posicionar datos en el eje de tiempo.

- `lib/usePolymarket.ts` + `components/PolymarketPanel.tsx` / `PolymarketChart.tsx` (SVG, pocos puntos): market en vivo e historial; el flujo del market en vivo se recorta del hook de orderflow. La tabla de historial NO sale del canal WS sino de la API HTTP del servidor (`lib/useMarketRows.ts`: `GET /api/markets` y `/api/markets/<slug>`; `HTTP_BASE` en `useWsChannel.ts`), para ver todos los markets guardados. Las señales de compra/venta (`PmSignal`) vienen del servidor; el frontend solo las dibuja y suma el resultado de papel.
- `PolymarketPanel` son tres bloques plegables: el market (gráfico), `.ops` (operaciones del market) y `.history` (tabla de markets guardados). El estado vive en el componente: elegir una fila del historial abre el market arriba. Motores con sección en el gráfico: `ASSET_INFO[asset].charts` (todos si falta). Los ejes de precio usan un rango mínimo proporcional al precio (`minSpanOf`) y decimales según el rango (`decOf`), para activos baratos (SOL).
- SS ([sol-strength](../../docs/features/sol-strength.md)): `usePolymarket` guarda `strength`/`reference` (mensajes `strength`/`ref`); `PolymarketChart` dibuja el motor C una vez por variante (`STRENGTH_VARIANTS`, nombres en `STRENGTH_LABEL`) con un punto por señal en el segundo en que se detectó (`ssMarks`) y los tokens de la referencia (BTC) una vez por variante; `StrengthList` en el panel. El cálculo es del servidor.
- Motores A y C: `usePolymarket` trae las muestras y operaciones de los dos (`point`/`signal` llevan `engine`); `PolymarketChart` dibuja una sección de probabilidad por motor (`engines: EngineSeries[]`); tabla y totales por motor (`PmMarketRow.engines`). Nombres en `lib/engines.ts`.
- `lib/useEngines.ts` + `components/EnginesDrawer.tsx`: canal `/ws/engines` (registro de decisiones de A y C) **bajo demanda** (`useWsChannel` con `path` null no conecta): solo con el drawer abierto. Textos de los impedimentos en `lib/engines.ts`. `components/ui/sheet.tsx`: drawer sobre el Dialog de Base UI.
- `lib/useTrading.ts` + `components/LiveTradingCard.tsx`: compras reales del motor A o C (selectores de motor e importe; upsert por `signalId`) (canal `/ws/trading`; interruptor por HTTP con contraseña en `localStorage`). Las ejecuciones se dibujan en la sección del motor seguido de `PolymarketChart` (`EngineSeries.real`).
- `app/replays/page.tsx` + `components/ReplaysView.tsx` + `lib/useReplays.ts`: página `/replays` (solo por URL, sin enlace en la navegación) con el informe `GET /api/replays` (motor A con ejecución retrasada).
- Predict.fun: el mismo `PolymarketPanel` con `venue="predict"` (`lib/venue.ts`: canales, API, textos; sin compras reales). Los hooks reciben la ruta: `usePolymarket(CHANNELS.predict)`, `useMarketRows(key, "/api/predict/markets")`, `useFetchRecord(base)`, `useEngines(open, CHANNELS.predictEngines)`, `useTrading(enabled, channel, armApi)`, `useLatency(channel)`. `LiveTradingCard` y `LatencyPanel` reciben `venue` (textos, moneda, sin check maker en Predict).
- `lib/useLatency.ts` + `components/LatencyPanel.tsx`: canal `/ws/latency` (latencia al CLOB medida por el servidor; reloj de la próxima medida con `exchangeClock`). `components/MakerProbeCard.tsx`: check maker, órdenes maker reales siguiendo a un motor (interruptor y motor con la contraseña de trading, `POST /api/latency/maker`).

## Convenciones
- Tipos de mensajes SOLO desde `@updown/protocol`; rutas desde `CHANNELS`. Peticiones HTTP de una fuente con `useApiUrl()` (no `HTTP_BASE` directo).
- Alias `@/` apunta a la raíz de `apps/web`.
- Los mensajes de alta frecuencia se acumulan en un ref y se vuelcan a estado una vez por frame (`requestAnimationFrame`); limitar el tamaño de las listas.
- Todo hook de canal expone el estado del enlace (`connecting|open|closed`) y el upstream, y la UI debe mostrarlo.
- Nada de lógica de dominio de Binance en el frontend; si hace falta, va al servidor.
- UI: shadcn/ui + Tailwind v4, blanco y negro con tema claro/oscuro ([ADR 0003](../../docs/decisions/0003-shadcn-ui-tailwind.md), [ADR 0019](../../docs/decisions/0019-rediseno-claro-oscuro-acordeones.md)). Preferir componentes `ui/`, `Panel` y `Segmented`, y utilidades Tailwind. Color solo para datos y con tokens que cambian con el tema: `buy`, `sell`, `warn`, `chain`, `info`, `gold`, `screen` (nunca `text-yellow-500` y similares). Dentro de un `Panel`, responsive con container queries (`@lg:`, `@4xl:`), no con breakpoints de ventana. Nada de CSS plano nuevo.
- IDs de elementos (`id`/`htmlFor`) y claves de `Panel` llevan el activo: la página muestra cada componente dos veces.
- Los hooks de canal podan por el `retentionMs` que envía el servidor (no por cantidad). Etiquetas/colores de señales en `lib/flow.ts`; el texto de escenarios sale de `SCENARIOS` (protocolo), no se duplica.
- Canvas de alta frecuencia (`BookmapChart`, `CvdChart`): las props se leen vía ref dentro del bucle rAF; lo costoso se cachea offscreen.
