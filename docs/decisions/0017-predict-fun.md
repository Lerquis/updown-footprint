# 0017 — Predict.fun con los mismos motores (precio puntual, sin TWAP)

- **Estado**: aceptada · 2026-11-27

## Contexto
Además de Polymarket se quiere seguir **Predict.fun** (BNB Chain). Tiene la misma serie BTC Up/Down de 5 minutos, con el mismo formato de slug. Las diferencias:
- resuelve con el **precio puntual** de Chainlink y no con un TWAP de 60 s;
- tiene un solo libro (Up), en lugar de dos tokens;
- su comisión es `rate·min(p, 1−p)`.

Se quiere ver y operar en papel igual que en Polymarket: misma gráfica, mismos motores A, C, D y E, y mismas señales.

## Decisión
- **Reutilizar la pila de Polymarket con adaptadores**, en lugar de una pila nueva. `PolymarketTracker` ya dependía de interfaces (`PolymarketApi`, `BookLike`). `PredictMarketApi` y `PredictBook` las implementan con tokens sintéticos `<marketId>:up|down`; Down es el espejo del libro de Up.
- **Una pila de Predict por fuente** (`predict/venue.ts`, creada en `source.ts`). Los motores usan el flujo de Binance de cada fuente, así que spot y futures tienen cada uno sus motores, su base (solo markets) y sus backups. Lo que no depende de Binance (rondas por REST, precio por WS) se comparte desde `index.ts`.
- **Motores sin TWAP** (`serverStrategy("predict")`):
  - `twapSeconds: 0`: el modelo usa el precio puntual;
  - `basisSeconds` corto (5 s);
  - comisión `feeKind: "min"`.
  Son campos opcionales y, por defecto, Polymarket se comporta exactamente igual (no hace falta subir `ENGINE_VERSION` ni cambiar de generación).
- **Precio desde el WS de Predict** (`chainlinkAssetPriceUpdate/1`, no documentado). Es el feed contra el que se resuelve y no necesita credenciales.
- **Mismos mensajes y mismo panel.** `/ws/predict` usa `PolymarketServerMessage`, `/ws/predict-engines` usa `EnginesServerMessage` y `/api/predict/markets` devuelve las mismas respuestas. El frontend reutiliza `PolymarketPanel` con `venue="predict"`.
- **Compras reales con la misma lógica que Polymarket** (interruptor por market, topes, A/C/D). Cambian estas cosas:
  - orden MARKET del SDK;
  - el mínimo de 1 USDT se garantiza sobre lo **firmado**, porque el SDK redondea hacia abajo;
  - la ejecución es asíncrona (eventos de la wallet).
  El login acepta los términos de Predict y por eso solo ocurre al activar. Al arrancar solo se lee de la cadena; las aprobaciones (con gas) las envía el usuario con `npm run predict:approvals`.
- **API key solo en `.env.local` / Railway** (`PREDICT_API_KEY`).

## Alternativas descartadas
- **Pila propia de Predict** (la fase 1, con un tracker propio y un panel simple): duplicaba la gráfica y no tenía motores.
- **Refactorizar `source.ts` para que Polymarket también use `createPredictVenue`/una "venue" genérica**: es lo ideal, pero toca las compras reales y el check maker, que están en producción. Queda pendiente. Hoy el cableado de Polymarket (`source.ts`) y el de Predict (`venue.ts`) son paralelos: **un cambio en uno se debe replicar en el otro.**

## Consecuencias
- Doble de motores (4 pilas: Polymarket y Predict × spot y futures): más CPU y memoria.
- Dos bases y dos carpetas de backups más, pequeñas porque solo guardan markets.
- Si el topic de precio no documentado desaparece, los motores de Predict se quedan sin Chainlink y no deciden (`noData`). Vigilar `health.predict.price`.
- El papel maker de E en Predict es menos fiel, porque no hay tamaños de trade (solo cambios de nivel).
