# 0006 — Orderflow, señales y monitor de escenarios calculados en el servidor

- **Estado**: aceptada · 2026-11-24

## Contexto
Se quieren marcar absorción, desequilibrios apilados, agotamiento y divergencias de CVD, y un monitor que los combine con la tendencia de precio y CVD en una lectura. Todos los usuarios deben ver lo mismo.

## Decisión
- Todo el cálculo vive en `apps/server/src/analysis/` y se emite como datos; el frontend solo dibuja. Dos canales nuevos: `/ws/orderflow` (barras footprint, CVD, señales) y `/ws/analysis` (monitor).
- **Se parte de los aggTrades que ya llegan** (sin nueva conexión a Binance): `OrderflowEngine` construye barras de `BAR_MS` por nivel de precio (`isBuyerMaker` ⇒ volumen *bid*, si no volumen *ask*), CVD por segundo y detecta señales al **cerrar** cada barra (no se retractan).
- Los detectores son **funciones puras con umbrales configurables** (`DetectorConfig`), con pruebas unitarias. Las definiciones exactas están en [orderflow-signals](../features/orderflow-signals.md).
- El monitor clasifica tendencia de precio y de CVD (sube/baja/plano) y evalúa un **catálogo cerrado de escenarios** (`SCENARIOS` en el protocolo: id, condición y significado; una función de prueba por id en `scenarios.ts`). Devuelve escenarios con peso 1-3, un score −100..100 y un sesgo. Ver [scenario-monitor](../features/scenario-monitor.md).
- Cada señal lleva `bias` (implicación alcista/bajista), independientemente de su nombre, para unificar la lectura.

## Consecuencias
- Son **heurísticas**, no verdades: los umbrales (ratio 3:1, 25 % de niveles extremos, 30 % de cuota, etc.) están elegidos de forma razonable pero sin backtesting. Hay que revisarlos con datos reales y por símbolo (el volumen mínimo está en activo base).
- Añadir un escenario = entrada en `SCENARIOS` + función en `TESTS` (el tipo `Record<ScenarioId,…>` obliga a mantenerlos en sincronía) + prueba.
- Las señales solo existen para barras cerradas: hay hasta `BAR_MS` de latencia; el monitor compensa usando la tendencia (continua) y el delta de la barra en formación.
- No hay confirmación con el libro (heatmap) todavía: p. ej. una absorción podría contrastarse con una pared pasiva en el mismo precio. Idea pendiente.
