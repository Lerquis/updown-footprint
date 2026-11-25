# 0009 — Servidor en Railway con SQLite en volumen y backups en R2

- **Estado**: aceptada · 2026-11-25

## Contexto
Los datos (markets, aggTrades, heatmap) son lo más valioso del proyecto y hoy solo se recogen mientras el PC local está encendido. Se quiere el servidor en la nube (Railway, región Amsterdam). Ritmo medido: ~190 MB/día de base (~1,9 M aggTrades/día).

## Decisión
- El servidor corre en Railway desde `apps/server/Dockerfile` (contexto: raíz del monorepo) con `apps/server/railway.json`.
- La base sigue siendo **SQLite (`node:sqlite`) en un Volume de Railway** (`/data`). Se descartan bases gestionadas: los planes gratuitos (MongoDB Atlas, Supabase, Neon ~0,5 GB; D1/Turso con límites de escrituras) se llenan en días a este ritmo, y migrar `MarketStore` a un cliente remoto/asíncrono añade latencia y riesgo sin beneficio.
- Copia fuera de Railway: backup periódico (`VACUUM INTO` en worker thread → gzip → subida multiparte S3 firmada a mano con SigV4, sin dependencias) a **Cloudflare R2**; restauración automática si el volumen está vacío (`PM_DB_RESTORE`).

## Consecuencias
- Sin cambios en el comportamiento local: el backup se activa solo con las variables `BACKUP_S3_*`.
- Una réplica (el volumen no se comparte): cada deploy pierde el market en curso.
- El coste crece con el volumen (~5,5 GB/mes). Si pesa, opciones futuras: comprimir los aggTrades por market en un blob, o archivar markets antiguos en R2.
- Cada backup es completo; con bases de decenas de GB conviene pasar a backups incrementales o archivado.
