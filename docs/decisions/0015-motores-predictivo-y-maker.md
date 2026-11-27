# 0015 — Motores D (predictivo) y E (maker); se elimina el motor B

- **Estado**: aceptada · 2026-11-27

## Contexto
- Las compras reales (ADR 0014) mostraron que una orden tarda 1–5 s en registrarse en Polymarket. Los replays del motor A confirman que su ventaja desaparece con ese retraso: +421 USDC ejecutando al instante, +26 con 1 s, −91 con 2 s.
- El motor B (+300 ms) daba casi lo mismo que C (+150 ms).
- El usuario pidió un motor más rápido y con mejores señales, y otro basado en el libro de órdenes que coloque, recoloque y cancele órdenes.

## Decisión
- **Eliminar B.** Deja de ejecutarse y de guardarse. Los markets antiguos conservan `engines.b` en su JSON, que se ignora. `PmEngineId` = `a|c|d|e`.
- **Motor D (taker predictivo),** cada 100 ms ([predictive-engines](../features/predictive-engines.md)):
  - deriva prevista por el flujo de Binance, con coeficientes ajustados con los datos guardados (`npm run calibrate`);
  - EV mínimo de 10¢ y **precio límite propio** (el peor precio que aún deja 3¢ de EV);
  - parámetros elegidos con un backtest separado en entrenamiento y prueba, con ejecución retrasada 1–3 s.
- **Motor E (maker):** órdenes límite en reposo, sin comisión. Cotiza solo con el flujo a favor, cancela en cuanto la idea muere, recoloca con histéresis y nunca deja dos órdenes vivas del mismo lado. Sale como maker o, si la probabilidad se hunde, como taker.
- **Papel realista para D y E:**
  - D se ejecuta 1,5 s después contra el libro completo real y respeta el límite;
  - E se simula con la cola real del libro y los trades de Polymarket;
  - para eso `BookClient` pasa a emitir niveles y trades, no solo el mejor bid/ask.
- **Compras reales:** se pueden seguir las de D, con su límite en la orden FAK. E queda **solo en papel** hasta validar su comportamiento.
- Mismo formato de base (generación v2): `engines.d/e` y columnas `d_*`/`e_*` se añaden sin romper lo anterior. `ENGINE_VERSION` 3.

## Alternativas descartadas
- **Bajar aún más el retraso de A/C:** no ataca el problema. El retraso que importa es el de Polymarket (1–5 s), no el del servidor (40 ms).
- **Mantener la orden sin límite (como A):** con 2–3 s de retraso la regla tipo A pierde fuera de muestra (−9 % / −11 %); con límite, D gana (+44 % / +21 %).
- **Maker uniéndose siempre al mejor bid:** en vivo había 300–1100 tokens por delante; casi nunca se ejecutaría. Se mejora el bid 1 tick cuando el spread lo permite.
- **Ejecutar E con dinero real ya:** su riesgo (selección adversa, órdenes que quedan vivas) solo se puede medir con su papel en vivo.

## Consecuencias
- D y E no son deterministas entre servidores: deciden con lo último recibido cada 100 ms, a diferencia de C.
- Sus netos de papel son más realistas que los de A/C, que siguen ejecutando al precio de la señal. No son directamente comparables.
- Más mensajes por WS: niveles y trades de Polymarket en el servidor; `point`/`signal`/`order` de D y E hacia la web.
