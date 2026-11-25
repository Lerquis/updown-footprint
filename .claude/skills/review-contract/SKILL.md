---
name: review-contract
description: Verifica la coherencia del contrato WebSocket entre servidor, frontend, packages/protocol y docs. Úsalo tras tocar mensajes o canales.
---
# Revisar contrato

1. Ejecuta `npm run typecheck` (el compilador detecta divergencias de tipos).
2. Lanza el agente `protocol-reviewer` y aplica sus correcciones.
3. Prueba en vivo: arranca `npm run dev:server` y conecta un cliente WS al canal; confirma que el primer mensaje es `snapshot`.
