# 0016 — Fuente futures en paralelo a spot (mismo servidor)

- **Estado**: aceptada · 2026-11-27

## Contexto
Todo el sistema (orderflow, motores A/C/D/E, compras reales) usaba Binance **spot**. En compras reales entramos 1–5 s tarde porque Polymarket se congestiona y el ask ya se movió. Probablemente el perpetuo BTCUSDT (más volumen, suele liderar el precio) da la señal antes. Se quiere comprobarlo con datos, viendo las dos fuentes en el mismo proyecto.

## Decisión
- **Un solo servidor con dos fuentes.** `createSource()` (`apps/server/src/source.ts`) crea una fuente completa, y `index.ts` la crea para `spot` y, si `FUTURES_ENABLED` (por defecto sí), para `futures`. Cada fuente incluye:
  - cliente de aggTrades, relleno, libro y orderflow;
  - escenarios y motores A, C, D y E;
  - su propio tracker de Polymarket, su **base**, sus **backups**, su `LiveTrader`, su check maker y sus canales.
- **Compartido:** Chainlink (el mismo precio de referencia) y el `LatencyMonitor` (la latencia al CLOB no depende de Binance).
- **Rutas.** Spot conserva las rutas de siempre. Futures va en `/ws/futures/<canal>` y `/api/futures/...`, y se construye con `sourcePath(source, CHANNELS.x)` del protocolo. Los mensajes no cambian.
- **Base de spot intacta.** Futures usa otra base (`polymarket-futures-v2.db`, al lado de la de spot) y otra carpeta de backups (`updown-futures/v2/`). No hace falta generación nueva porque el formato no cambia.
- **Compras reales activables en las dos fuentes**, cada una con su interruptor (misma contraseña y misma cartera). El tope por market es **por fuente**: con las dos activadas, la exposición máxima por market se duplica.
- **Comparativa:** `GET /api/compare` empareja por slug los markets guardados por las dos fuentes. Por motor da el adelanto de la primera entrada (spot − futures, mismo lado) y la diferencia de precio de entrada. Página `/compare`.
- **Libro de futuros.** Los diffs se encadenan con `pu` (`bridgesDiff`) y el snapshot admite como máximo 1000 niveles. El relleno pagina más despacio (`/fapi/v1/aggTrades` pesa 20).

## Alternativas descartadas
- **Segundo servicio en Railway con otras variables:** cero código, pero dos despliegues, dos webs y la comparativa entre dos bases remotas. El usuario prefiere un solo proyecto.
- **Mezclar las dos fuentes en los mismos motores** (spot para el precio, futures para el flujo): es la idea de fondo, pero antes hay que medir si futures adelanta. Queda para después de la comparativa.

## Consecuencias
- Doble de conexiones a Binance y a Polymarket (libro de tokens, gamma), y doble de CPU y memoria de motores.
- **El volumen crece más rápido.** Futures tiene más aggTrades que spot, así que la base de futures crecerá más que la de spot, que ya va por ~190 MB/día. Además, el backup necesita espacio libre temporal. Vigilar el tamaño del volumen.
- La calibración de la deriva (`data/calibration.json`) se hizo con spot y se usa también en futures. Sus variables están normalizadas (−1..1, sigmas), pero conviene recalibrar con datos de futuros cuando haya días guardados.
- Replays (`npm run replays`) y calibración siguen leyendo solo la base de spot.
