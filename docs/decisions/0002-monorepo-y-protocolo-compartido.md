# 0002 — Monorepo con npm workspaces y paquete de protocolo

- **Estado**: aceptada · 2026-11-24

## Contexto
Servidor y frontend deben compartir el contrato de mensajes sin que diverja.

## Decisión
npm workspaces: `apps/server`, `apps/web`, `packages/protocol`. El protocolo se publica como TS fuente (`main: src/index.ts`): Next lo transpila con `transpilePackages`, el servidor corre con `tsx` (también en producción, sin paso de build propio).

## Consecuencias
- Un cambio de contrato rompe el typecheck en ambos lados.
- Sin build del servidor a JS; si se necesita en el futuro, compilar el protocolo y cambiar `main`.
