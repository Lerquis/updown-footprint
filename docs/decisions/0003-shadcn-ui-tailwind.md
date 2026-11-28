# 0003 — shadcn/ui + Tailwind v4 para el frontend

- **Estado**: aceptada · 2026-11-24

## Contexto
Hacía falta normalizar la UI del frontend con una librería de componentes consistente en vez de CSS plano.

## Decisión
shadcn/ui (estilo `base-nova`, basado en Base UI) sobre Tailwind v4, tema oscuro por defecto (`<html class="dark">`; desde el [ADR 0019](0019-rediseno-claro-oscuro-acordeones.md), tema claro/oscuro elegible). Componentes en `apps/web/components/ui` (código propio, se editan libremente); `cn()` en `lib/utils.ts`. Colores de mercado como tokens: `text-buy` / `text-sell`. Los componentes de dominio van en `apps/web/components`.

## Consecuencias
- Añadir componentes: `npx shadcn@latest add <nombre>` desde `apps/web`.
- **Revisar tras cada `add`/`init`**: el CLI generó `import { cn } from "cn"` (paquete npm equivocado) y lo instaló como dependencia; se corrigió a `@/lib/utils` (clsx + tailwind-merge) y se desinstaló `cn`.
- El bug se repite en cada `add` (reinstala `cn` y puede pedir confirmación para sobrescribir `button.tsx`): usar `add <x> --yes --overwrite`, luego `sed -i 's#from "cn"#from "@/lib/utils"#' components/ui/*.tsx` y `npm uninstall -w @updown/web cn`.
- No ejecutar `next build` y `next dev` sobre la misma carpeta `.next` (da `__webpack_modules__[moduleId] is not a function`); borrar `apps/web/.next` si ocurre.
- El canvas de la gráfica no usa Tailwind para dibujar; sus colores viven en `BookmapChart.tsx` (fondo `bg-screen`, siempre oscuro).
