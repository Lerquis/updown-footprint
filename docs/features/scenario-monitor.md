> **Reemplazado en la UI** por el [motor de señales](signal-engine.md) (2026-11-24). El canal `/ws/analysis` y `scenarios.ts` siguen en el servidor, pero `AnalysisPanel` ya no está en el dashboard.

# Monitor de escenarios

**Estado**: implementada (2026-11-24). Decisión: [ADR 0006](../decisions/0006-orderflow-y-monitor-en-servidor.md). Canal `/ws/analysis`.

**Objetivo**: leer a la vez precio, CVD y señales de footprint y devolver una interpretación ("agotamiento + CVD sube + precio baja ⇒ …"), siempre como apoyo y no como recomendación.

## Cómo decide (`apps/server/src/analysis/`)
1. **Tendencias** (cada segundo, ventana `ANALYSIS_LOOKBACK_MS` = 5 min), a partir de los puntos de CVD: *precio* sube/baja si |Δ| ≥ 0,01 % del precio, si no plano; *CVD* sube/baja si |ΔCVD| / volumen de la ventana ≥ 10 %, si no plano.
2. **Señales recientes**: las detectadas en las últimas `ANALYSIS_RECENT_BARS` (3) barras.
3. **Escenarios** (`scenarios.ts`): cada id del catálogo tiene una función que devuelve 0 (no aplica) o su peso 1-3. Hay 9 combinaciones precio × CVD, variantes de agotamiento / absorción / apilados / divergencias que dependen de si precio y CVD las confirman o las contradicen, y 3 combinadas: `confluence-bullish/bearish` (≥ 2 señales distintas del mismo sesgo y ninguna contraria) y `mixed` (señales contrarias a la vez).
4. **Score** = `100 × (alcistas − bajistas) / (alcistas + bajistas + 2)` con la suma de pesos; sesgo *alcista* si ≥ 25, *bajista* si ≤ −25, si no *neutral*.
5. Se emite `summary` cada segundo y `change` (con registro de los últimos 50) cuando cambia el sesgo o el conjunto de escenarios.

## Ejemplos del catálogo
| Situación | Escenario | Lectura |
|---|---|---|
| Agotamiento vendedor + precio baja + CVD sube | `exhaustion-down-reversal` (peso 3, alcista) | La caída se agota y entran compradores agresivos: candidato a giro alcista |
| Agotamiento alcista + precio sube + CVD baja | `exhaustion-up-div` (peso 3, bajista) | Rally sin respaldo ni volumen en el extremo |
| Precio baja + CVD sube, sin señales | `down-cvd-up` (neutral) | Compras agresivas absorbidas por venta pasiva; esperar confirmación |
| Absorción compradora + CVD baja | `absorption-buy` (peso 3, alcista) | Las ventas agresivas se gastan contra compra pasiva |
| Apilados vendedores + precio baja | `stacked-sell-trend` (peso 2, bajista) | Venta institucional sostenida; zonas de resistencia en rebotes |
El catálogo completo está en `packages/protocol/src/index.ts` (`SCENARIOS`) y se muestra al usuario en el modal "?" (`FlowGuide`).

## Frontend
- `AnalysisPanel`: badge de sesgo + barra de score, métricas (tendencia de precio/CVD, delta de la barra actual), "Lectura actual" con los escenarios (el principal resaltado, puntos de importancia) y registro de cambios.

## Pendiente / ideas
- Pesos y umbrales aprendidos con datos históricos; distinguir regímenes (rango vs tendencia).
- Notificaciones al cambiar de sesgo; persistir el registro de cambios.
- Incorporar la liquidez del heatmap (paredes pasivas) como condición.
