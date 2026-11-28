"use client";

import { useAsset } from "@/lib/source";
import { useState } from "react";
import type { LiveEngine, MakerProbeSample } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { LatencyView } from "@/lib/useLatency";

type Key = "signMs" | "postMs" | "userAckMs" | "bookMs" | "firstFillMs" | "cancelMs" | "userCancelMs" | "bookGoneMs";

/** Lo que se mide, en el orden en que ocurre (ms desde el envio de cada peticion) */
const METRICS: { key: Key; label: string; help: string }[] = [
  { key: "signMs", label: "Firmar", help: "Firmar la orden en el servidor (EIP-712) y preparar las cabeceras" },
  { key: "postMs", label: "POST /order", help: "Ida y vuelta de la petición que coloca la orden límite post-only. Una orden que no casa al llegar no pasa por la retención de las órdenes taker" },
  { key: "userAckMs", label: "Confirmada", help: "Desde el envío hasta el evento PLACEMENT de tu canal de usuario" },
  { key: "bookMs", label: "En el libro", help: "Desde el envío hasta que aparece en el libro público (aproximado: cambio de su nivel con su tamaño). Desde ahí los demás la ven y cuenta su lugar en la fila" },
  { key: "firstFillMs", label: "1ª ejecución", help: "Desde el envío hasta la primera ejecución (evento trade del canal de usuario)" },
  { key: "cancelMs", label: "DELETE /order", help: "Ida y vuelta de la cancelación (a los 2 s si no se llenó entera)" },
  { key: "userCancelMs", label: "Cancelación confirmada", help: "Desde el envío de la cancelación hasta el evento CANCELLATION" },
  { key: "bookGoneMs", label: "Fuera del libro", help: "Desde el envío de la cancelación hasta que la orden desaparece del libro público: hasta entonces alguien podría ejecutarla" },
];

const STATUS: Record<MakerProbeSample["status"], { label: string; cls: string }> = {
  filled: { label: "llena", cls: "text-buy" },
  partial: { label: "parcial", cls: "text-warn" },
  unfilled: { label: "sin ejecutar", cls: "text-muted-foreground" },
  rejected: { label: "rechazada", cls: "text-sell" },
  skipped: { label: "omitida", cls: "text-muted-foreground" },
  error: { label: "error", cls: "text-sell" },
};

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v)} ms`);
const tone = (ms: number | null) => (ms === null ? "text-muted-foreground" : ms < 150 ? "text-buy" : ms < 400 ? "text-warn" : "text-sell");
const cents = (v: number) => `${(v * 100).toFixed(0)}¢`;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const col = (h: MakerProbeSample[], k: Key) => h.map((s) => s[k]).filter((v): v is number => v !== null);

/**
 * Check maker: órdenes maker reales (límite post-only a mejor bid + 1 tick) siguiendo al motor A o C;
 * se cancelan a los 2 s si no se llenan. Mide cada paso y cuántas se ejecutan. Interruptor con la contraseña de trading.
 */
export function MakerProbeCard({ lat }: { lat: LatencyView }) {
  const [pass, setPass] = useState("");
  const [askPass, setAskPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const asset = useAsset();
  const st = lat.maker.state;
  const h = lat.maker.history;
  const sent = h.filter((s) => s.time !== null);
  const eng = engine ?? st?.engine ?? "c";

  const toggle = async (on: boolean, password?: string, e: LiveEngine = eng) => {
    setBusy(true);
    setErr(null);
    const r = await lat.setMaker(on, password, e);
    setBusy(false);
    if (r === "falta la contraseña" || r === "contraseña incorrecta") setAskPass(true);
    else if (!r) {
      setAskPass(false);
      setPass("");
    }
    setErr(r === "falta la contraseña" ? null : r);
  };

  if (!st) return null;
  const filled = sent.filter((s) => s.status === "filled" || s.status === "partial").length;
  return (
    <div className="border-t px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch id={`maker-check-${asset}`} checked={st.enabled} disabled={busy || !st.available} onCheckedChange={(v) => void toggle(v)} />
          <Label htmlFor={`maker-check-${asset}`} className="font-semibold">
            Check maker: órdenes límite reales
          </Label>
        </div>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[eng]}
          disabled={busy}
          onValueChange={(v) => {
            const next = v[0] as LiveEngine | undefined;
            if (!next) return;
            setEngine(next);
            if (st.enabled) void toggle(true, undefined, next);
          }}
        >
          <ToggleGroupItem value="a">Motor A</ToggleGroupItem>
          <ToggleGroupItem value="c">Motor C</ToggleGroupItem>
        </ToggleGroup>
        {st.enabled && <Badge className="bg-sell text-white">ACTIVO · dinero real · {st.done}/{st.max}</Badge>}
        {!st.available && <span className="text-[11px] text-muted-foreground">No disponible: {st.reason}</span>}
      </div>
      {askPass && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void toggle(true, pass);
          }}
        >
          <input
            type="password"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Contraseña de trading"
            className="h-8 w-48 rounded-md border bg-transparent px-2 text-sm outline-none focus:border-foreground/40"
          />
          <Button size="sm" type="submit" disabled={!pass || busy}>
            Activar
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setAskPass(false)}>
            Cancelar
          </Button>
        </form>
      )}
      {err && <p className="mt-1 text-[11px] text-sell">{err}</p>}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Con cada compra del motor {eng.toUpperCase()} deja una compra límite post-only a <b>mejor bid + 1 tick</b> (si el spread es de 1 tick, se une al
        mejor bid) de máx({st.minUsd} USDC, {st.minShares} tokens), y la cancela a los {st.restMs / 1000} s si no se llenó. Sus ventas hacen lo mismo en el
        ask con los tokens comprados así. Solo el market en curso, máximo {st.maxMarketUsd} USDC por market, se apaga solo tras {st.max} órdenes. Lo que
        no se vende lo liquida Polymarket al cierre. Para comparar: una compra taker real tardó 255–1707 ms en responder.
      </p>
      {st.currentSlug && (st.spentUsd > 0 || st.position.up > 0 || st.position.down > 0) && (
        <p className="mt-1 font-mono text-[11px]">
          En este market: gastado {st.spentUsd.toFixed(2)} USDC · <span className="text-buy">Up {st.position.up}</span> ·{" "}
          <span className="text-sell">Down {st.position.down}</span> tokens
        </p>
      )}

      {h.length > 0 && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            {METRICS.map((m) => {
              const v = median(col(sent, m.key));
              return (
                <div key={m.key} className="flex flex-col" title={m.help}>
                  <span className="text-[11px] text-muted-foreground">{m.label}</span>
                  <span className={`font-mono text-sm font-semibold ${tone(v)}`}>{fmt(v)}</span>
                </div>
              );
            })}
            <span className="self-end text-[10px] text-muted-foreground">
              mediana de {sent.length} órdenes enviadas · ejecutadas {filled}/{sent.length}
            </span>
          </div>
          <div className="mt-2 max-h-72 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hora</TableHead>
                  <TableHead>Motor</TableHead>
                  <TableHead>Orden</TableHead>
                  <TableHead className="text-right" title="Precio de la señal → precio de la orden maker">
                    Señal → orden
                  </TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  {METRICS.map((m) => (
                    <TableHead key={m.key} className="text-right" title={m.help}>
                      {m.label}
                    </TableHead>
                  ))}
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h
                  .slice()
                  .reverse()
                  .map((s) => (
                    <TableRow key={s.signalId}>
                      <TableCell className="font-mono">{new Date(s.time ?? s.signalTime).toLocaleTimeString("es", { hour12: false })}</TableCell>
                      <TableCell className="font-mono">{s.engine.toUpperCase()}</TableCell>
                      <TableCell className={s.side === "up" ? "text-buy" : "text-sell"}>
                        {s.action === "buy" ? "Compra" : "Venta"} {s.side === "up" ? "Up" : "Down"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {cents(s.signalPrice)} → {s.price ? cents(s.price) : "–"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {s.filledShares > 0 ? `${s.filledShares}/` : ""}
                        {s.size || "–"}
                      </TableCell>
                      {METRICS.map((m) => (
                        <TableCell key={m.key} className={`text-right font-mono ${tone(s[m.key])}`}>
                          {fmt(s[m.key])}
                        </TableCell>
                      ))}
                      <TableCell className={`max-w-56 truncate text-[11px] ${STATUS[s.status].cls}`} title={s.error ?? undefined}>
                        {STATUS[s.status].label}
                        {s.error && <span className="ml-1 text-muted-foreground">· {s.error}</span>}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
