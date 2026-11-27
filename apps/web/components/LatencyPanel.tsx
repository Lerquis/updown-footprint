"use client";

import { useEffect, useState } from "react";
import type { LatencyProbe, LatencyProbeId, LatencySample } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { exchangeClock } from "@/lib/exchangeClock";
import type { LatencyView } from "@/lib/useLatency";
import { LiveBadge } from "./LiveBadge";
import { MakerProbeCard } from "./MakerProbeCard";

const PROBES: { id: LatencyProbeId; label: string; help: string }[] = [
  { id: "connect", label: "Conexión nueva", help: "GET /time abriendo conexión (DNS + TCP + TLS + ida y vuelta): lo que cuesta una orden si no hay conexión abierta. El servidor la mantiene siempre abierta (HTTP/2), así que no se paga" },
  { id: "edge", label: "Red (Cloudflare)", help: "PING de HTTP/2: lo responde el borde de Cloudflare más cercano. Es la red pura, sin pasar por los servidores de Polymarket" },
  { id: "ping", label: "Ping", help: "GET /time por la conexión HTTP/2 abierta: red + ida y vuelta Cloudflare ↔ servidores de Polymarket" },
  { id: "book", label: "Libro (REST)", help: "GET /book: solo hace falta si el precio se pide por REST (clob-client sin precio). El servidor ya tiene el libro por WebSocket, así que no suma a la orden estimada" },
  { id: "auth", label: "GET autenticado", help: "GET /balance-allowance con las cabeceras L2 (HMAC), mismo gateway que POST /order" },
  { id: "order", label: "POST /order", help: "POST /order con una orden de compra completa (tu proxy wallet, token del market, 1 USDC, FOK) firmada con ceros a propósito: Polymarket la valida y la rechaza al verificar la firma, justo antes del matching. Nunca puede ejecutarse" },
];

const fmtMs = (ms: number | null) => (ms === null ? "–" : `${Math.round(ms)} ms`);
/** verde < 250 ms · amarillo < 500 ms · rojo */
const tone = (ms: number | null) => (ms === null ? "text-muted-foreground" : ms < 250 ? "text-buy" : ms < 500 ? "text-yellow-500" : "text-sell");
const fmtTime = (t: number) => new Date(t).toLocaleTimeString("es", { hour12: false });

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Reloj de la medida: anillo que se vacía hasta la siguiente ronda del servidor. */
function MeasureClock({ last, intervalMs }: { last: number | null; intervalMs: number }) {
  const [now, setNow] = useState(() => exchangeClock.now());
  useEffect(() => {
    const id = setInterval(() => setNow(exchangeClock.now()), 250);
    return () => clearInterval(id);
  }, []);
  const elapsed = last === null ? 0 : Math.max(0, now - last);
  const left = last === null ? null : Math.max(0, intervalMs - elapsed);
  const frac = left === null ? 0 : left / intervalMs;
  const R = 20;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex items-center gap-3">
      <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0" aria-hidden>
        <circle cx="26" cy="26" r={R} fill="none" strokeWidth="4" className="stroke-muted" />
        <circle
          cx="26"
          cy="26"
          r={R}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          className="stroke-primary transition-[stroke-dashoffset] duration-200 ease-linear"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          transform="rotate(-90 26 26)"
        />
        <text x="26" y="30" textAnchor="middle" className="fill-foreground font-mono text-[11px]">
          {left === null ? "–" : `${Math.ceil(left / 1000)}s`}
        </text>
      </svg>
      <div className="flex flex-col text-[11px] text-muted-foreground">
        <span>
          Medido a las <b className="font-mono text-foreground">{last === null ? "–" : fmtTime(last)}</b>
        </span>
        <span>{last === null ? "esperando primera medida…" : left === 0 ? "midiendo…" : `hace ${Math.floor(elapsed / 1000)} s · cada ${intervalMs / 1000} s`}</span>
      </div>
    </div>
  );
}

function Sparkline({ history }: { history: LatencySample[] }) {
  const vals = history.map((s) => s.estimateMs);
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const W = 220;
  const H = 40;
  const hi = Math.max(...nums);
  const lo = Math.min(...nums);
  const span = hi - lo || 1;
  const pts = vals
    .map((v, i) => (v === null ? null : `${(i / Math.max(1, vals.length - 1)) * W},${H - 3 - ((v - lo) / span) * (H - 6)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="text-primary" aria-label="Historial de la orden estimada">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ProbeStat({ label, help, p }: { label: string; help: string; p: LatencyProbe | undefined }) {
  const status = p?.status;
  return (
    <div className="flex flex-col" title={[help, p?.detail && `Polymarket: ${p.detail}`, p?.error && `Error: ${p.error}`].filter(Boolean).join("\n\n")}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${tone(p?.ms ?? null)}`}>
        {fmtMs(p?.ms ?? null)}
        {status != null && status !== 200 && <span className="ml-1 text-[10px] font-normal text-yellow-500">HTTP {status}</span>}
      </span>
      {p?.detail && <span className="max-w-48 truncate text-[10px] text-muted-foreground">{p.detail}</span>}
    </div>
  );
}

/** De dónde sale el tiempo de la orden: red hasta Cloudflare, Cloudflare ↔ Polymarket + validación, y preparación local. */
function Breakdown({ s }: { s: LatencySample }) {
  const order = s.probes.order.ms;
  const edge = s.probes.edge.ms;
  if (order === null) return null;
  const rest = edge === null ? null : Math.max(0, order - edge);
  return (
    <span
      className="text-[10px] text-muted-foreground"
      title="Red: PING hasta el borde de Cloudflare. Polymarket: el resto del POST /order (Cloudflare ↔ servidores de Polymarket + validación). Preparar: cuerpo + HMAC"
    >
      red {fmtMs(edge)} · polymarket {fmtMs(rest)} · preparar {s.prepMs === null ? "–" : `${s.prepMs.toFixed(2)} ms`}
    </span>
  );
}

export function LatencyPanel({ lat }: { lat: LatencyView }) {
  const last = lat.history.at(-1) ?? null;
  const ests = lat.history.map((s) => s.estimateMs).filter((v): v is number => v !== null);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-3">
        <CardTitle>Latencia a Polymarket</CardTitle>
        <CardDescription>
          Cuánto tardaría aproximadamente una compra/venta desde el servidor hasta el CLOB{lat.target && ` (${lat.target})`}. Se envía
          una orden real firmada con ceros: Polymarket la rechaza siempre, nunca compra. No incluye el tiempo de matching.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {lat.region && (
            <Badge variant="outline" title="Desde dónde mide el servidor (región de Railway o tu PC)">
              {lat.region === "local" ? "Desde: local" : `Desde: ${lat.region}`}
            </Badge>
          )}
          <LiveBadge label="Latencia" link={lat.link} upstream={lat.upstream} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 px-4 py-3">
        <MeasureClock last={last?.time ?? null} intervalMs={lat.intervalMs} />
        <div
          className="flex flex-col"
          title="Preparar la orden + POST /order por la conexión HTTP/2 ya abierta (como un bot conectado, con el precio del libro por WebSocket). Si falla, GET autenticado o ping"
        >
          <span className="text-[11px] text-muted-foreground">Orden estimada</span>
          <span className={`font-mono text-2xl font-semibold ${tone(last?.estimateMs ?? null)}`}>{fmtMs(last?.estimateMs ?? null)}</span>
          {last && <Breakdown s={last} />}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {PROBES.map((p) => (
            <ProbeStat key={p.id} label={p.label} help={p.help} p={last?.probes[p.id]} />
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Últimas {ests.length} medidas · mín <b className="font-mono text-foreground">{fmtMs(ests.length ? Math.min(...ests) : null)}</b> · mediana{" "}
            <b className="font-mono text-foreground">{fmtMs(median(ests))}</b> · máx{" "}
            <b className="font-mono text-foreground">{fmtMs(ests.length ? Math.max(...ests) : null)}</b>
          </span>
          <Sparkline history={lat.history} />
        </div>
      </CardContent>
      {!lat.authReady && lat.link === "open" && (
        <p className="border-t px-4 py-1.5 text-[11px] text-yellow-500">
          Falta <code>PM_SIGNER_ADDRESS</code> en el servidor: el GET autenticado y POST /order responden 401 antes de validar la orden. La
          latencia sigue siendo la del gateway; con la dirección, POST /order llega hasta la validación (400) y da la medida exacta.
        </p>
      )}
      <MakerProbeCard lat={lat} />
    </Card>
  );
}
