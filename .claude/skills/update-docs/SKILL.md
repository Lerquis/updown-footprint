---
name: update-docs
description: Al terminar una tarea de código, determina y aplica las actualizaciones de documentación necesarias según la arquitectura granular de docs/. Úsalo siempre antes de dar una tarea por cerrada.
---
# Actualizar documentación

1. Revisa qué cambió (archivos tocados en la tarea).
2. Aplica la tabla de `/CLAUDE.md` ("Si cambias… actualiza…"):
   - protocolo → `packages/protocol` + `docs/architecture/protocol.md`
   - estructura/flujo → `docs/architecture/overview.md`
   - decisión técnica → nuevo ADR `docs/decisions/NNNN-titulo.md` (siguiente número libre, formato en `0001`)
   - feature → `docs/features/<feature>.md` + tabla en `docs/features/README.md`
   - ejecución/env → `docs/guides/development.md`
   - convención de una app → `apps/<app>/CLAUDE.md`
3. Si se añadió un doc nuevo, enlázalo desde `docs/README.md` (o el README de su carpeta).
4. No dupliques contenido: enlaza al doc dueño del hecho.
5. Mantén `/CLAUDE.md` corto (mapa + reglas); el detalle va en `docs/`.
6. Reporta en una línea qué docs actualizaste.
