# Footprint, CVD y señales de orderflow

**Estado**: implementada (2026-11-24). Decisión: [ADR 0006](../decisions/0006-orderflow-y-monitor-en-servidor.md).

## Datos
- **Barra footprint** (`FootprintBar`, `BAR_MS` = 1 min): por cada nivel de precio (`FOOTPRINT_TICK`, 1 USDT) el volumen **bid** (ventas agresivas) y **ask** (compras agresivas), más OHLC, volumen, delta y CVD de cierre.
- **CVD**: suma acumulada de (compra agresiva − venta agresiva) en activo base, muestreada cada segundo. Arranca en 0 al inicio de la memoria del servidor (15 min atrás con relleno); lo útil es su **forma y pendiente**, no el valor absoluto.
- Código: `apps/server/src/analysis/engine.ts` (construcción) y `detectors.ts` (señales). Pruebas: `analysis.test.ts`.

## Definición de cada señal (al cerrar una barra)
Parámetros: `DEFAULT_DETECTOR` en `detectors.ts` (algunos por env, ver [development](../guides/development.md)).

| Señal | Regla | `bias` |
|---|---|---|
| **Desequilibrio diagonal** (marca por nivel) | Compra en P si `ask(P) ≥ 3 × bid(P−tick)` y `ask(P) ≥ IMBALANCE_MIN_VOL`. Venta en P si `bid(P) ≥ 3 × ask(P+tick)` y `bid(P) ≥ IMBALANCE_MIN_VOL`. Un vecino vacío cuenta como 0. | — (solo marcas) |
| **Desequilibrio apilado** | ≥ `IMBALANCE_MIN_STACK` (3) niveles **consecutivos** con marca del mismo lado. Una señal por tramo; `strength` = nº de niveles. | compra → alcista · venta → bajista |
| **Absorción** | La barra tiene ≥ 4 niveles y volumen ≥ 70 % del medio de las 5 previas. En el 25 % de niveles del extremo (≥ 2): ≥ 30 % del volumen de la barra **y** delta del extremo ≤ −20 % de su volumen (en mínimos; ≥ +20 % en máximos) **y** cierre en la mitad opuesta de la barra. `strength` = cuota de volumen. | compradora (mínimos) → alcista · vendedora (máximos) → bajista |
| **Agotamiento** | La barra extiende el extremo de la anterior ≥ 2 ticks y los 2 niveles extremos tienen ≤ 5 % del volumen de la barra, con fuerza decreciente (volumen ≤ el de la barra previa, o delta a favor ≤ el de la previa). | en máximos (compradores agotados) → bajista · en mínimos → alcista |
| **Divergencia de CVD** | Nuevo máximo de precio (≥ 2 ticks sobre el mayor de las 8 barras previas) con CVD de cierre menor que el de esa barra por más de 15 % del volumen medio de barra ⇒ bajista; simétrico con mínimos ⇒ alcista. `link` guarda los dos puntos (precio, CVD). | bajista (máximos) / alcista (mínimos) |

## En pantalla
- **Gráfica de precio** (switch *Señales*): apilados = rectángulo punteado en la zona con `IMB▲×n`; absorción = recuadro sólido `ABS`; agotamiento = círculo `AGOT` en el extremo; divergencia = línea discontinua entre los dos extremos `DIV` (también en la gráfica de CVD). Verde ▲ alcista, rojo ▼ bajista.
- **Footprint por barra** (`FootprintPanel`): tabla de barras con delta, CVD y badges de señales; al elegir una barra, escalera bid | precio | ask con los desequilibrios recuadrados, apilados con barra lateral y POC.
- Explicación para el usuario: botón "?" del monitor (`FlowGuide`).

## Pendiente / ideas
- Confirmar absorción con la liquidez pasiva del heatmap; detectar absorción también intrabarra.
- Umbrales por símbolo y backtesting; alertas cuando aparece una señal.
- Footprint dibujado dentro de la gráfica (celdas con números) al hacer mucho zoom.
