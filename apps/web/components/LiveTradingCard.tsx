"use client";

import { useState } from "react";
import type { LiveEngine, LiveSizing, LiveTrade } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtClockHMS } from "@/lib/flow";
import type { TradingView } from "@/lib/useTrading";

const cents = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}¢`);
const ms = (v: number | null) => (v === null ? "–" : `${Math.round(v)} ms`);
const STATUS: Record<LiveTrade["status"], { label: string; cls: string }> = {
  matched: { label: "ejecutada", cls: "border-buy/40 text-buy" },
  delayed: { label: "con retraso", cls: "border-yellow-500/40 text-yellow-500" },
  unmatched: { label: "sin liquidez", cls: "border-yellow-500/40 text-yellow-500" },
  rejected: { label: "rechazada", cls: "border-sell/40 text-sell" },
  error: { label: "error", cls: "border-sell/40 text-sell" },
  skipped: { label: "omitida", cls: "text-muted-foreground" },
};

/**
 * Interruptor de compras reales (motor C, solo el market en curso; se apaga solo al terminar) y registro de lo ejecutado:
 * señal vs. ejecución (precio y tiempo). Datos en memoria del servidor, no se guardan.
 */
export function LiveTradingCard({ tr, slug }: { tr: TradingView; slug: string }) {
  const [pass, setPass] = useState("");
  const [askPass, setAskPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = tr.state;
  // motor y modo de importe: los del servidor; se envian al activar (o al cambiarlos con el interruptor activado)
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const [sizing, setSizing] = useState<LiveSizing | null>(null);
  const eng = engine ?? st?.engine ?? "c";
  const siz = sizing ?? st?.sizing ?? "scaled";
  const armed = !!st && st.armedSlug === slug;
  const isCurrent = !!st && st.currentSlug === slug;

  const toggle = async (on: boolean, password?: string, opts: { engine?: LiveEngine; sizing?: LiveSizing } = {}) => {
    if (on && !tr.hasPassword && !password) {
      setAskPass(true);
      return;
    }
    setBusy(true);
    setErr(null);
    const e = await tr.setArmed(slug, on, { password, engine: opts.engine ?? eng, sizing: opts.sizing ?? siz });
    setBusy(false);
    setErr(e);
    if (e === "contraseña incorrecta") setAskPass(true);
    else if (!e) {
      setAskPass(false);
      setPass("");
    }
  };

  const trades = armed || tr.trades.some((t) => t.slug === slug) ? tr.trades.filter((t) => t.slug === slug) : [];
  const done = trades.filter((t) => t.status === "matched");
  const avg = (f: (t: LiveTrade) => number | null) => {
    const v = done.map(f).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  return (
    <div className={`rounded-md border p-3 ${armed ? "border-sell/60 bg-sell/5" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch id="live" checked={armed} disabled={busy || !st?.enabled || (!armed && !isCurrent)} onCheckedChange={(v) => void toggle(v)} />
          <Label htmlFor="live" className="font-semibold">
            Compras reales en este market
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
            if (armed) void toggle(true, undefined, { engine: next });
          }}
        >
          <ToggleGroupItem value="a" title="Motor A: decide en el segundo exacto (lo antes posible)">
            Motor A
          </ToggleGroupItem>
          <ToggleGroupItem value="c" title="Motor C: decide 150 ms después del segundo">
            Motor C
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[siz]}
          disabled={busy}
          onValueChange={(v) => {
            const next = v[0] as LiveSizing | undefined;
            if (!next) return;
            setSizing(next);
            if (armed) void toggle(true, undefined, { sizing: next });
          }}
        >
          <ToggleGroupItem value="scaled" title="Paper ÷ 5: entre 1 y 10 USDC">
            Proporcional
          </ToggleGroupItem>
          <ToggleGroupItem value="min" title="Lo mínimo que acepta Polymarket y se puede vender después: máx(1 USDC, 5 tokens)">
            Mínimo
          </ToggleGroupItem>
        </ToggleGroup>
        {armed && <Badge className="bg-sell text-white">ACTIVO · dinero real</Badge>}
        {st && !st.enabled && <span className="text-[11px] text-muted-foreground">No disponible: {st.disabledReason}</span>}
        {st?.enabled && !isCurrent && !armed && <span className="text-[11px] text-muted-foreground">Solo en el market en curso</span>}
        {tr.hasPassword && (
          <button className="ml-auto text-[11px] text-muted-foreground underline" onClick={tr.forgetPassword}>
            olvidar contraseña
          </button>
        )}
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
            placeholder="Contraseña"
            className="h-8 w-40 rounded-md border bg-transparent px-2 text-sm outline-none focus:border-foreground/40"
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

      {st && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Sigue cada compra/venta del motor {eng.toUpperCase()} con{" "}
          {siz === "min" ? "el importe mínimo (máx(1 USDC, 5 tokens))" : `${st.limits.scale === 0.2 ? "paper ÷ 5" : `paper × ${st.limits.scale}`} (${st.limits.minUsd}–${st.limits.maxUsd} USDC, mínimo 5 tokens)`}, máximo{" "}
          {st.limits.maxMarketUsd} USDC por market, orden FAK {st.limits.slippage >= 0.98 ? "sin límite de precio" : `con límite señal ±${Math.round(st.limits.slippage * 100)}¢`}. Se apaga solo al terminar el
          market. No se guarda.
          {armed && (
            <>
              {" "}
              Posición: Up {st.position.up.shares.toFixed(2)} · Down {st.position.down.shares.toFixed(2)} tokens · gastado {st.spentUsd.toFixed(2)} USDC.
            </>
          )}
        </p>
      )}

      {trades.length > 0 && (
        <>
          <p className="mt-2 text-[11px]">
            Ejecutadas {done.length}/{trades.length} · señal → ejecución{" "}
            <b className="font-mono">{ms(avg((t) => (t.matchedAt === null ? null : t.matchedAt - t.signalTime)))}</b> · señal → respuesta{" "}
            <b className="font-mono">{ms(avg((t) => (t.respondedAt === null ? null : t.respondedAt - t.signalTime)))}</b> · orden{" "}
            <b className="font-mono">{ms(avg((t) => t.latencyMs))}</b> · deslizamiento medio{" "}
            <b className="font-mono">{cents(avg((t) => t.slippage))}</b>
          </p>
          <Table className="mt-1 text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Señal</TableHead>
                <TableHead>Motor</TableHead>
                <TableHead>Operación</TableHead>
                <TableHead className="text-right">Precio señal</TableHead>
                <TableHead className="text-right">Límite</TableHead>
                <TableHead className="text-right">Precio real</TableHead>
                <TableHead className="text-right">Desliz.</TableHead>
                <TableHead className="text-right">Tokens / USDC</TableHead>
                <TableHead className="text-right" title="Desde el segundo de la señal hasta que Polymarket ejecutó la orden (hora de Polymarket, canal de usuario)">
                  Señal→ejec.
                </TableHead>
                <TableHead className="text-right" title="Desde el segundo de la señal hasta la respuesta de Polymarket">
                  Señal→resp.
                </TableHead>
                <TableHead className="text-right" title="Ida y vuelta de POST /order (firma aparte)">
                  Orden
                </TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades
                .slice()
                .reverse()
                .map((t) => (
                  <TableRow key={t.signalId} title={t.detail ?? undefined}>
                    <TableCell className="font-mono">{fmtClockHMS(t.signalTime)}</TableCell>
                    <TableCell className="font-mono">{t.engine.toUpperCase()}</TableCell>
                    <TableCell className={t.side === "up" ? "text-buy" : "text-sell"}>
                      {t.action === "buy" ? "Compra" : "Venta"} {t.side === "up" ? "Up" : "Down"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{cents(t.signalPrice)}</TableCell>
                    <TableCell className="text-right font-mono">{cents(t.limitPrice)}</TableCell>
                    <TableCell className="text-right font-mono">{cents(t.avgPrice)}</TableCell>
                    <TableCell className={`text-right font-mono ${t.slippage === null ? "" : t.slippage > 0 ? "text-sell" : "text-buy"}`}>{cents(t.slippage)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {t.filledShares ? `${t.filledShares.toFixed(2)} / ${t.filledUsd.toFixed(2)}` : t.requestedUsd !== null ? `(${t.requestedUsd.toFixed(2)} USDC)` : t.requestedShares !== null ? `(${t.requestedShares} tok.)` : "–"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{ms(t.matchedAt === null ? null : t.matchedAt - t.signalTime)}</TableCell>
                    <TableCell className="text-right font-mono">{ms(t.respondedAt === null ? null : t.respondedAt - t.signalTime)}</TableCell>
                    <TableCell className="text-right font-mono">{ms(t.latencyMs)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS[t.status].cls}>
                        {STATUS[t.status].label}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
