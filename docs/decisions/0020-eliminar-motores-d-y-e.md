# 0020 — Se eliminan los motores D (predictivo) y E (maker)

- **Estado**: aceptada · 2026-11-28 · sustituye a [ADR 0015](0015-motores-predictivo-y-maker.md) (salvo la eliminación del motor B, que sigue)

## Contexto
Los motores D (taker predictivo, cada 100 ms, con la deriva del flujo de Binance) y E (órdenes maker en reposo con papel de cola real) se añadieron con el ADR 0015. El usuario decidió quitarlos del código: el trabajo sigue con los motores A y C y con SS ([sol-strength](../features/sol-strength.md)).

## Decisión
- Se borran del servidor: `predictive.ts`, `maker.ts`, `paper.ts`, `micro.ts`, `fastRunner.ts`, su prueba (`fastEngines.test.ts`), `research/calibrate.ts` y `npm run calibrate`. También las variables `PM_FAST_*`, `PM_D_*`, `PM_E_*`, `PM_DRIFT_GAIN`, `PM_CALIBRATION_PATH` y `PM_PAPER_*`.
- Protocolo: `PmEngineId` = `a | c`; `LiveEngine` = `a | c`. Desaparecen `PmOrder`, el mensaje `order`, `PmPoint.drift`, los campos de D/E en `PmSignal` (`limit`, `signalPrice`, `execTime`, `maker`), los bloqueos `pending`/`quoting`/`drift` y `PmEngineInfo.kind` / `mode: "fast"`.
- Se queda el libro L2 de Polymarket (`pmBook.ts`, `PmBooks`): lo usan el check maker y las compras reales de Predict. Lo alimenta directamente `source.ts` (y `predict/venue.ts`).
- Compras reales y check maker siguen al motor A o C.
- Web: sin secciones, tarjetas, selectores ni columnas de D y E.

## Consecuencias
- **Datos guardados:** los markets ya guardados conservan `engines.d` / `engines.e` en su JSON y las columnas `d_*` / `e_*` en `markets`. No se borran ni se migran, y no hace falta nueva generación de base: el servidor y la web simplemente los ignoran (como `engines.b`). Los markets nuevos ya no los traen.
- Un servidor de la versión anterior y uno de esta pueden compartir base sin problemas.
- Si se quiere recuperar D o E, el código está en la historia de git (commit anterior a este ADR).
