# 0013 — Backups cada hora, al apagar y con puntero que no retrocede

- **Estado**: aceptada · 2026-11-27 · Amplía [0009](0009-railway-volumen-y-backups-r2.md)

## Contexto
El 27 nov (deploy del commit de latencia) el servidor de Railway arrancó con `/data` vacío, aunque el volumen está montado en `/data`. Se perdieron ~22 h de markets v2 (del 26 nov 03:06 al 27 nov ~01:00 UTC), por tres motivos:
- **R2 solo recibía una copia cada 24 h.** Las copias v2 que había tenían 0 markets: se hicieron 2 min después de arrancar.
- **No había copia al apagar.** Railway avisa con SIGTERM antes de cada deploy, pero el servidor solo cerraba la base.
- **`latest.json` se movió a la copia vacía.** El servidor arrancó vacío y a los 2 min hizo backup y lo apuntó como el más reciente. Si se hubiera restaurado, se habría restaurado la vacía.

En el bucket se ve el mismo patrón en v1: cuatro copias el mismo día, una por deploy.

**Causa (confirmada con `/health` → `db.path: "data/polymarket-v2.db"`, `onVolume: false`):** en las variables de Railway estaba `PM_DB_PATH=data/polymarket.db`, una ruta **relativa** copiada de `.env.example`. Esa variable pisaba la del Dockerfile (`/data/polymarket.db`), así que la base vivía en `/app/apps/server/data/`, dentro del contenedor, y se borraba en cada deploy. El volumen `/data` nunca se usó.

## Decisión
- **Copias cada hora** (`BACKUP_INTERVAL_H`, por defecto 1).
- **Retención:** todas las copias de las últimas 48 h (`BACKUP_KEEP_H`) y, de las anteriores, la primera de cada día UTC (`backupsToPrune`). Solo dentro del prefijo de la generación.
- **Copia final al apagar:** en SIGTERM se hace backup antes de cerrar la base, con un máximo de `BACKUP_SHUTDOWN_TIMEOUT_S` (150 s). `railway.json` fija `drainingSeconds: 180`.
- **`latest.json` nunca retrocede:** guarda `markets`. Una copia con menos markets que la apuntada se sube igual, pero el puntero no se mueve (`shouldMoveLatest`) y se registra con `console.error`.
- **La base siempre va al volumen:** si Railway define `RAILWAY_VOLUME_MOUNT_PATH` y `PM_DB_PATH` queda fuera de él, se usa el mismo nombre de archivo dentro del volumen (`resolveDbPath`, con prueba) y se avisa en el log.
- **Restauración por defecto en Railway** (`PM_DB_RESTORE`, por defecto `true` si existe `RAILWAY_ENVIRONMENT`). Solo actúa si falta la base.
- **`/health` → `db`:** ruta, tamaño, `onVolume` (la carpeta es otro sistema de archivos que `/`) y estado del backup. En Railway, si `onVolume` es falso, se avisa en el log al arrancar.

## Alternativa descartada por ahora
**Litestream** (replicación continua del WAL a R2, ~1 s de pérdida máxima) es lo más completo. No se pudo probar en este equipo. Queda como siguiente paso: añadir el binario al Dockerfile y lanzar el servidor con `litestream replicate -exec`.

## Consecuencias
- Si el volumen vuelve a fallar, se pierde como mucho 1 h. Con un deploy ordenado no se pierde nada, porque hay copia final.
- R2 guarda ~48 copias recientes más una por día. Con bases de cientos de MB, conviene vigilar el tamaño del bucket.
