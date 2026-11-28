# Updown Footprint

Monorepo (npm workspaces): **servidor Node** que consume datos de mercado una sola vez y los distribuye por WebSocket a un **frontend Next.js**. Todos los usuarios ven los mismos datos y, al entrar, ya hay datos (snapshot) en lugar de empezar un consumo nuevo.

## Mapa
| Ruta | Qué es | Guía propia |
|---|---|---|
| `apps/server` | Node + TypeScript + `ws`. Consume Binance (BTC y ETH, spot y futures), guarda buffer en memoria, expone canales WS | `apps/server/CLAUDE.md` |
| `apps/web` | Next.js (App Router) + React + shadcn/ui + Tailwind v4. Se suscribe a canales WS del servidor | `apps/web/CLAUDE.md` |
| `packages/protocol` | Tipos y constantes del contrato WS (única fuente de verdad) | `packages/protocol/src/index.ts` |
| `docs/` | Documentación granular. Índice: `docs/README.md` | — |

## Comandos
- `npm install` · `npm run dev` (server :4000 + web :3000) · `npm run typecheck` · `npm run test -w @updown/server` · `npm run build`
- Servidor: `npm run dev -w @updown/server` · Web: `npm run dev -w @updown/web`
- Health: `GET http://localhost:4000/health`

## Reglas no negociables
1. **El navegador nunca habla con Binance.** Solo con nuestro servidor.
2. **Todo mensaje WS se define primero en `packages/protocol`** y se documenta en `docs/architecture/protocol.md`. Nunca tipos duplicados en server/web.
3. **Un canal WS por tipo de dato** (`/ws/<nombre>`), cada uno con snapshot al conectar + deltas.
4. Todos los timestamps viajan en el reloj de Binance; el servidor no estampa con su propio reloj.
5. El servidor normaliza los datos crudos del exchange; el frontend jamás ve payloads crudos.
6. TypeScript estricto. `npm run typecheck` debe pasar antes de dar una tarea por terminada.
7. Configuración por variables de entorno (`.env.example` en cada app); sin secretos en el repo.
8. La lógica de análisis (detectores, escenarios) vive en el servidor como funciones puras **con prueba unitaria**; el catálogo `SCENARIOS` (protocolo) y sus funciones (`scenarios.ts`) deben mantenerse en sincronía.

## Documentación: dónde leer y dónde escribir
Lee `docs/README.md` (índice) antes de tareas no triviales. Regla: **cada hecho vive en un solo documento**; los demás lo enlazan.

| Si cambias… | Actualiza |
|---|---|
| Mensajes/canales WS | `packages/protocol` + `docs/architecture/protocol.md` |
| Detectores, señales o escenarios | `docs/features/orderflow-signals.md` / `scenario-monitor.md`, catálogo `SCENARIOS`, prueba en `analysis.test.ts`, y el texto de `FlowGuide` si cambia lo que ve el usuario |
| Estructura, flujo de datos, componentes | `docs/architecture/overview.md` |
| Una decisión técnica relevante | Nuevo ADR en `docs/decisions/NNNN-titulo.md` |
| Una funcionalidad nueva/modificada | `docs/features/<feature>.md` |
| Cómo ejecutar/operar/probar | `docs/guides/*.md` |
| Convenciones de una app | el `CLAUDE.md` de esa app |

Skill `update-docs` automatiza este chequeo al terminar una tarea. Agentes en `.claude/agents/`, skills en `.claude/skills/`.

## Estado actual
Ver `docs/features/README.md` para la lista de features y su estado.
