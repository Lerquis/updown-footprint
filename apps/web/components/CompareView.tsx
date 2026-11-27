"use client";

import Link from "next/link";
import { useState } from "react";
import type { CompareEngineMarket, CompareEngineTotals, PmEngineId } from "@updown/protocol";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ENGINE_IDS, ENGINE_LABEL } from "@/lib/engines";
import { useCompare } from "@/lib/useCompare";
import { cn } from "@/lib/utils";

const LIMITS = [48, 96, 288] as const;

const usd = (v: number | null) => (v === null ? "–" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);
const cents = (v: number | null) => (v === null ? "–" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}¢`);
const msTxt = (v: number | null) => (v === null ? "–" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("es")} ms`);
const tone = (v: number | null) => (v === null || v === 0 ? "text-muted-foreground" : v > 0 ? "text-buy" : "text-sell");
const fmtDate = (t: number) => new Date(t).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const side = (s: "up" | "down" | null) => (s === null ? "–" : s === "up" ? "Up" : "Down");

function TotalsTable({ totals }: { totals: Record<PmEngineId, CompareEngineTotals> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Motor</TableHead>
          <TableHead className="text-right">P&L spot</TableHead>
          <TableHead className="text-right">P&L futures</TableHead>
          <TableHead className="text-right">Operaciones s / f</TableHead>
          <TableHead className="text-right" title="Markets en que las dos fuentes entraron por el mismo lado">
            Mismo lado
          </TableHead>
          <TableHead className="text-right">Futures antes / después</TableHead>
          <TableHead className="text-right" title="Positivo = futures entró antes">
            Adelanto medio · mediana
          </TableHead>
          <TableHead className="text-right" title="Precio de entrada de spot − el de futures. Positivo = futures compró más barato">
            Precio entrada
          </TableHead>
          <TableHead className="text-right">Solo s / solo f / opuesto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ENGINE_IDS.map((id) => {
          const t = totals[id];
          return (
            <TableRow key={id}>
              <TableCell className="font-medium">{ENGINE_LABEL[id]}</TableCell>
              <TableCell className={cn("text-right font-mono", tone(t.spotNet))}>{usd(t.spotNet)}</TableCell>
              <TableCell className={cn("text-right font-mono", tone(t.futuresNet))}>{usd(t.futuresNet)}</TableCell>
              <TableCell className="text-right font-mono">
                {t.spotTrades} / {t.futuresTrades}
              </TableCell>
              <TableCell className="text-right font-mono">{t.sameSide}</TableCell>
              <TableCell className="text-right font-mono">
                <span className="text-buy">{t.futuresFirst}</span> / <span className="text-sell">{t.spotFirst}</span>
              </TableCell>
              <TableCell className={cn("text-right font-mono", tone(t.avgLeadMs))}>
                {msTxt(t.avgLeadMs)} · {msTxt(t.medianLeadMs)}
              </TableCell>
              <TableCell className={cn("text-right font-mono", tone(t.avgPriceDiff))}>{cents(t.avgPriceDiff)}</TableCell>
              <TableCell className="text-right font-mono text-muted-foreground">
                {t.onlySpot} / {t.onlyFutures} / {t.oppositeSide}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function EngineCell({ e }: { e: CompareEngineMarket }) {
  if (!e.spotSide && !e.futuresSide) return <span className="text-muted-foreground">sin entradas</span>;
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px]">
      <span>
        {side(e.spotSide)} / {side(e.futuresSide)}
        {e.leadMs !== null && <span className={cn("ml-2", tone(e.leadMs))}>{msTxt(e.leadMs)}</span>}
        {e.priceDiff !== null && <span className={cn("ml-2", tone(e.priceDiff))}>{cents(e.priceDiff)}</span>}
      </span>
      <span className="text-muted-foreground">
        <span className={tone(e.spot.net)}>{usd(e.spot.net)}</span> / <span className={tone(e.futures.net)}>{usd(e.futures.net)}</span>
      </span>
    </div>
  );
}

/**
 * Página /compare: los mismos motores con Binance spot y con futures, en los mismos markets de Polymarket. Lo que más importa es
 * si futures entra antes (adelanto) y más barato (precio de entrada), por el retraso con que se ejecuta en Polymarket.
 */
export function CompareView() {
  const [limit, setLimit] = useState<number>(96);
  const st = useCompare(limit);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Comparativa spot vs futures</h1>
        <Link href="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Volver al panel
        </Link>
      </header>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-3">
          <CardTitle>Totales por motor</CardTitle>
          <CardDescription>
            Markets guardados por las dos fuentes. <b>Adelanto</b> = hora de la primera entrada de spot − la de futures, cuando las dos
            entraron por el mismo lado (positivo: futures antes). <b>Precio entrada</b> = precio de spot − el de futures (positivo: futures
            compró más barato). P&L de papel.
          </CardDescription>
          <CardAction>
            <ToggleGroup variant="outline" size="sm" spacing={0} value={[String(limit)]} onValueChange={(v) => v[0] && setLimit(Number(v[0]))}>
              {LIMITS.map((l) => (
                <ToggleGroupItem key={l} value={String(l)}>
                  {l === 288 ? "24 h" : `${(l * 5) / 60} h`}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {st.status === "loading" && <p className="p-4 text-sm text-muted-foreground">Cargando…</p>}
          {st.status === "error" && <p className="p-4 text-sm text-sell">No se pudo cargar: {st.message}</p>}
          {st.status === "ready" && !st.data.futuresEnabled && (
            <p className="p-4 text-sm text-muted-foreground">El servidor no tiene la fuente futures activada (FUTURES_ENABLED=false).</p>
          )}
          {st.status === "ready" && st.data.futuresEnabled && st.data.markets.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              Aún no hay markets guardados por las dos fuentes. Cada market de 5 min se guarda al resolverse, si el servidor lo vio completo.
            </p>
          )}
          {st.status === "ready" && st.data.markets.length > 0 && <TotalsTable totals={st.data.totals} />}
        </CardContent>
      </Card>

      {st.status === "ready" && st.data.markets.length > 0 && (
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-3">
            <CardTitle>Markets ({st.data.markets.length})</CardTitle>
            <CardDescription>
              Por motor: lado de la primera entrada spot / futures, adelanto y diferencia de precio, y P&L spot / futures.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Resultado</TableHead>
                  {ENGINE_IDS.map((id) => (
                    <TableHead key={id}>{ENGINE_LABEL[id]}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {st.data.markets.map((m) => (
                  <TableRow key={m.slug}>
                    <TableCell className="font-mono text-xs">{fmtDate(m.start)}</TableCell>
                    <TableCell className={m.result === "up" ? "text-buy" : "text-sell"}>{m.result === "up" ? "Up" : "Down"}</TableCell>
                    {ENGINE_IDS.map((id) => (
                      <TableCell key={id}>
                        <EngineCell e={m.engines[id]} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
