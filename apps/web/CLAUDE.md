# apps/web

Next.js (App Router) + React 19 + TypeScript. Solo habla con nuestro servidor vía WebSocket (`NEXT_PUBLIC_WS_URL`).

## Estructura
- `app/` — rutas y layout (Server Components por defecto).
- `components/ui/` — shadcn/ui (generados, editables). `components/` — componentes de dominio; los que usan hooks llevan `"use client"`.
- `lib/useWsChannel.ts` — conexión WS genérica con reconexión. `lib/use<Canal>.ts` — un hook por canal sobre `useWsChannel`: estado + datos.
- `lib/chartView.ts` + `chartInteractions.ts` — vista (zoom/desplazamiento) **compartida** por los canvas de precio y CVD; vive fuera de React.
- `lib/exchangeClock.ts` — reloj de Binance estimado; usarlo (no `Date.now()`) para posicionar datos en el eje de tiempo.

- `lib/usePolymarket.ts` + `components/PolymarketPanel.tsx` / `PolymarketChart.tsx` (SVG, pocos puntos): market en vivo e historial; el flujo del market en vivo se recorta del hook de orderflow. La tabla de historial NO sale del canal WS sino de la API HTTP del servidor (`lib/useMarketRows.ts`: `GET /api/markets` y `/api/markets/<slug>`; `HTTP_BASE` en `useWsChannel.ts`), para ver todos los markets guardados. Las señales de compra/venta (`PmSignal`) vienen del servidor; el frontend solo las dibuja y suma el resultado de papel.
- Tres motores (A, B, C): `usePolymarket` trae las muestras y operaciones de los tres (`point`/`signal` llevan `engine`); `PolymarketChart` dibuja una sección de probabilidad por motor (`engines: EngineSeries[]`); tabla y totales por motor (`PmMarketRow.engines`). Nombres en `lib/engines.ts`.
- `lib/useEngines.ts` + `components/EnginesDrawer.tsx`: canal `/ws/engines` (registro de decisiones de A, B y C) **bajo demanda** (`useWsChannel` con `path` null no conecta): solo con el drawer abierto. Textos de los impedimentos en `lib/engines.ts`. `components/ui/sheet.tsx`: drawer sobre el Dialog de Base UI.
- `lib/useTrading.ts` + `components/LiveTradingCard.tsx`: compras reales del motor C (canal `/ws/trading`; interruptor por HTTP con contraseña en `localStorage`). Las ejecuciones se dibujan en la sección del motor C de `PolymarketChart` (`EngineSeries.real`).
- `lib/useLatency.ts` + `components/LatencyPanel.tsx`: canal `/ws/latency` (latencia al CLOB medida por el servidor; reloj de la próxima medida con `exchangeClock`).

## Convenciones
- Tipos de mensajes SOLO desde `@updown/protocol`; rutas desde `CHANNELS`.
- Alias `@/` apunta a la raíz de `apps/web`.
- Los mensajes de alta frecuencia se acumulan en un ref y se vuelcan a estado una vez por frame (`requestAnimationFrame`); limitar el tamaño de las listas.
- Todo hook de canal expone el estado del enlace (`connecting|open|closed`) y el upstream, y la UI debe mostrarlo.
- Nada de lógica de dominio de Binance en el frontend; si hace falta, va al servidor.
- UI: shadcn/ui + Tailwind v4, tema oscuro ([ADR 0003](../../docs/decisions/0003-shadcn-ui-tailwind.md)). Preferir componentes `ui/` y utilidades Tailwind; colores de mercado `text-buy`/`text-sell`. Nada de CSS plano nuevo.
- Los hooks de canal podan por el `retentionMs` que envía el servidor (no por cantidad). Etiquetas/colores de señales en `lib/flow.ts`; el texto de escenarios sale de `SCENARIOS` (protocolo), no se duplica.
- Canvas de alta frecuencia (`BookmapChart`, `CvdChart`): las props se leen vía ref dentro del bucle rAF; lo costoso se cachea offscreen.
