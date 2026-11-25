# Arquitectura general

```
Binance WS/REST ─────────────────────────────▶ apps/server ──(WS por canal)──▶ N navegadores (apps/web)
 <sym>@aggTrade  (+ REST aggTrades al arrancar)  ├─ buffer 15 min ───────────────▶ /ws/aggtrades
                                                  └─ OrderflowEngine
                                                       barras footprint 1 min · CVD 1 s · señales ─▶ /ws/orderflow
                                                       └─ AnalysisMonitor (tendencias + señales → escenarios) ─▶ /ws/analysis
  (Polymarket: Chainlink WS + libro Up/Down WS + REST gamma y past-results ─▶ PolymarketTracker + flujo de Binance ─▶ /ws/polymarket)
 <sym>@depth@100ms + REST snapshot → OrderBook → muestreo 1 s ───────────────────────────────────────▶ /ws/depth
```

## Principio
El servidor es el **único consumidor** de datos de mercado y el **único dueño de la lógica de análisis**: mantiene estado en memoria, de modo que un usuario que entra recibe un **snapshot inmediato** y luego deltas en vivo; todos ven los mismos datos y las mismas señales. Ver [ADR 0001](../decisions/0001-servidor-como-consumidor-unico.md) y [ADR 0006](../decisions/0006-orderflow-y-monitor-en-servidor.md).

## Componentes
| Componente | Responsabilidad |
|---|---|
| `AggTradeClient` (`server/src/binance`) | Conexión upstream, normalización, reconexión exponencial, estado `connecting/connected/reconnecting` |
| `backfillTrades` (`server/src/binance`) | Al arrancar descarga `RETENTION_MS` de aggTrades por REST; luego se solapa con el vivo (dedupe por id) |
| `DepthClient` (`server/src/binance`) | Sincroniza el `OrderBook` local (snapshot REST + diffs, resync si hay hueco). [ADR 0004](../decisions/0004-libro-local-y-heatmap.md) |
| `TradeBuffer`, `OrderBook`, `DepthHistory` (`server/src/store`) | Memoria: trades por tiempo, libro por nivel, columnas del heatmap |
| `OrderflowEngine` (`server/src/analysis/engine.ts`) | Trades → barras footprint, CVD por segundo, detección de señales al cerrar cada barra |
| `PolymarketTracker` (`server/src/polymarket/tracker.ts`) | Rota el market de 5 min con el reloj de Binance, muestrea Chainlink y los precios de los tokens Up/Down cada segundo y archiva cada market terminado con su footprint/CVD/señales |
| `detectors.ts` | Funciones puras: desequilibrios, apilados, absorción, agotamiento, divergencia de CVD |
| `SignalEngine` (`server/src/polymarket/strategy.ts`) + `model.ts` | Probabilidad de Up (precio, price to beat, tiempo, volatilidad, flujo) → señales de compra/venta con EV neto de comisión; ver [signal-engine](../features/signal-engine.md) |
| `MarketStore` (`polymarket/store.ts`) + `rebuild.ts` | SQLite (`node:sqlite`): markets resueltos y completos, más todos los aggTrades y las columnas del heatmap en continuo; `rebuildOrderflow` rehace footprint/CVD/señales |
| `DbBackup` (`backup/`) | Copia periódica de la base a S3/R2 y restauración al arrancar sin base ([deployment.md](../guides/deployment.md)) |
| `AnalysisMonitor` + `scenarios.ts` | Tendencias de precio/CVD + señales recientes → escenarios activos, score y sesgo |
| `Channel<M>` (`server/src/ws/channel.ts`) | Canal WS genérico: snapshot al conectar + broadcast. Una instancia por tipo de dato |
| `index.ts` | Composición, tubería de trades, muestreos de 1 s, HTTP `/health`, enrutado de upgrade, check de Origin |
| `useWsChannel` (`web/lib`) | Conexión WS genérica con reconexión; la usan todos los hooks |
| `useAggTrades`, `useDepth`, `useOrderflow`, `useAnalysis` (`web/lib`) | Estado de cada canal (poda por `retentionMs`) |
| `exchangeClock` (`web/lib`) | Estimación del reloj de Binance en el navegador |
| `ChartView` + `chartInteractions` (`web/lib`) | Zoom/desplazamiento compartido por la gráfica de precio y la de CVD |
| `BookmapChart`, `CvdChart` (`web/components`) | Canvas: heatmap + burbujas + señales; CVD con divergencias |
| `AnalysisPanel` (sin uso en el dashboard), `FootprintPanel`, `FlowGuide` | Monitor de escenarios, tabla/escalera footprint, guía |
| `components/ui` | Componentes shadcn/ui ([ADR 0003](../decisions/0003-shadcn-ui-tailwind.md)) |
| `@updown/protocol` | Tipos, constantes y catálogo `SCENARIOS` del contrato |

## Estado y límites actuales
- Estado solo en memoria; sin persistencia. Memoria de **15 min** (`RETENTION_MS`) para trades, heatmap y CVD; 60 barras (1 h) para footprint y señales. Ver [ADR 0005](../decisions/0005-retencion-15min-y-backfill.md).
- Al reiniciar, trades/CVD/footprint se reconstruyen por REST (relleno); **el heatmap no** (Binance no da libro histórico): se rellena en vivo.
- Una sola instancia del servidor (el broadcast es en-proceso).
- Un símbolo por servidor (`SYMBOL`).
- El heatmap cubre solo mid ± `DEPTH_RANGE_PCT` y la profundidad que Binance entrega (snapshot de 5000 niveles por lado).
