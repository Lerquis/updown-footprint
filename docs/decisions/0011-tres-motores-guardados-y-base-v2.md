# 0011 — Tres motores cronometrados guardados y base de datos v2

- **Estado**: aceptada · 2026-11-25 · Sustituye en parte a [0010](0010-motor-sincronizado.md)

## Contexto
Con el motor B (sincronizado, solo en memoria) se vio que el instante y los datos con que decide el motor cambian sus operaciones. El usuario quiere recolectar desde cero, de forma correcta, los datos de varias variantes para compararlas. Las variantes son: decidir lo antes posible, o esperar 150 o 300 ms con datos "a fecha".

## Decisión
- Tres motores con las mismas reglas, todos cronometrados con el reloj de Binance:
  - **A:** T + 0 ms, con lo último recibido. Reemplaza al motor original de fase arbitraria, que queda en la rama `v1-personal-pc-overpowered`.
  - **B:** T + 300 ms, datos con marca de tiempo ≤ T.
  - **C:** T + 150 ms, datos con marca de tiempo ≤ T.
- Los tres se guardan por market: muestras y operaciones (`PmRecord.points/trades` para A, `PmRecord.engines.b/c`). El registro de decisiones no se guarda porque se reproduce con replay. `ENGINE_VERSION` 2.
- **Base nueva sin borrar la anterior:**
  - la generación `v2` se añade al nombre de `PM_DB_PATH` (`polymarket.db` → `polymarket-v2.db`);
  - los backups van a `<BACKUP_PREFIX>v2/`;
  - la base anterior se sube **una vez** a `<BACKUP_PREFIX>archive/` (marca `.archived` al lado) y no se toca;
  - no cambia ninguna variable de entorno en Railway.

## Consecuencias
- Datos limpios y comparables de los tres motores desde el primer market de v2.
- Los markets anteriores siguen en `polymarket.db` (en el volumen y en el archivo de R2), pero la web ya no los muestra.
- Unos 50 MB/día más de base por las muestras de B y C.
- El tracker ya no muestrea: recoge los pasos de los motores (`addStep`) y se mueve en el segundo exacto junto al motor A.
