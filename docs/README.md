# Índice de documentación

Cada hecho vive en **un solo** documento. Los demás lo enlazan.

| Carpeta / archivo | Contenido | Cuándo se actualiza |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | Componentes, flujo de datos, topología | Cambia la estructura o el flujo |
| [architecture/protocol.md](architecture/protocol.md) | Canales WS y mensajes (espejo de `packages/protocol`) | Cambia cualquier mensaje/canal |
| [decisions/](decisions/) | ADRs: una decisión por archivo, `NNNN-titulo.md` | Se toma una decisión técnica relevante |
| [features/](features/README.md) | Un doc por funcionalidad + estado | Se crea o modifica una feature |
| [guides/development.md](guides/development.md) | Setup, comandos, variables de entorno, pruebas | Cambia el modo de ejecutar/operar |
| [guides/deployment.md](guides/deployment.md) | Servidor en Railway, volumen de la base, backups/restauración en R2 | Cambia el despliegue o los backups |

## Reglas para la IA
- **Leer**: este índice → el doc del área que tocas → el `CLAUDE.md` de la app.
- **Crear**: ADR nuevo (copiar formato de `0001`), feature doc nuevo (formato en `features/README.md`). Nunca duplicar contenido: enlazar.
- **Actualizar**: usar la tabla de "Si cambias… actualiza…" de `/CLAUDE.md`. Skill `update-docs`.
- Documentos cortos y concretos; si superan ~150 líneas, dividir.
