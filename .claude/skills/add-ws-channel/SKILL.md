---
name: add-ws-channel
description: Receta para añadir un nuevo canal de datos servidor→frontend (nuevo stream de Binance + canal WS + hook + UI + docs). Úsalo al implementar cualquier feature de datos nueva (trades, depth, klines, etc.).
---
# Añadir un canal WebSocket

Sigue en orden:

1. **Protocolo** — en `packages/protocol/src/index.ts`: tipo normalizado, unión `<Nombre>ServerMessage` (`snapshot` + deltas + `status` si aplica) y entrada en `CHANNELS` (`/ws/<nombre>`).
2. **Upstream** — `apps/server/src/binance/<nombre>Client.ts`, copiando el patrón de `aggTradeClient.ts` (reconexión, normalización, eventos `data`/`state`).
3. **Store** — `apps/server/src/store/`: buffer/estado en memoria acotado.
4. **Canal** — `new Channel<NombreServerMessage>(() => ({ type: "snapshot", ... }))` con el `Channel<M>` genérico de `apps/server/src/ws/channel.ts` (snapshot al conectar + `broadcast`). Si el dato es histórico, incluir `retentionMs` en el snapshot.
5. **Wiring** — en `apps/server/src/index.ts`: instanciar el canal, conectar eventos (`channel.broadcast(...)`) y `mount(CHANNELS.<nombre>, canal)`. Si el dato sale de trades, engancharlo a la tubería `ingest`; si es análisis, funciones puras en `src/analysis/` con prueba.
6. **Frontend** — `apps/web/lib/use<Nombre>.ts` (patrón de `useAggTrades.ts`) y componente en `apps/web/components/`.
7. **Docs** — `docs/architecture/protocol.md`, `docs/features/<nombre>.md` + fila en `features/README.md`, `overview.md` si cambia el flujo, ADR si hay decisión relevante.
8. **Verificar** — `npm run typecheck`, prueba del canal con un cliente WS de Node, `npm run build -w @updown/web`.
9. Pasa el agente `protocol-reviewer` al final.
