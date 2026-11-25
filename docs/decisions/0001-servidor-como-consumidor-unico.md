# 0001 — Servidor como consumidor único de datos

- **Estado**: aceptada · 2026-11-24

## Contexto
Si cada navegador consumiera Binance, cada visita empezaría de cero y cada usuario vería datos distintos.

## Decisión
Un servidor Node mantiene las conexiones upstream y el estado en memoria; el frontend (Next.js) se suscribe a canales WebSocket propios (uno por tipo de dato) y recibe snapshot + deltas.

## Consecuencias
- Datos idénticos para todos y disponibles al instante.
- El servidor es punto único: una instancia, estado volátil (ver límites en `architecture/overview.md`).
- Escalar horizontalmente requerirá un bus (p. ej. Redis) — nueva ADR cuando haga falta.

## Formato de ADR
Título `NNNN — …`, **Estado** (propuesta/aceptada/reemplazada) y fecha, **Contexto**, **Decisión**, **Consecuencias**.
