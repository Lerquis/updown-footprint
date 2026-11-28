"use client";

import { useState } from "react";
import { ASSETS, type CompareEngineMarket, type CompareEngineTotals, type MarketAsset, type PmEngineId } from "@updown/protocol";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ENGINE_IDS, ENGINE_LABEL } from "@/lib/engines";
import { useCompare } from "@/lib/useCompare";
import { cn } from "@/lib/utils";
import { ASSET_INFO } from "@/lib/source";
import { AppHeader } from "./AppHeader";
import { Panel } from "./Panel";
import { Segmented } from "./Segmented";

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
export function CompareView({ initialAsset }: { initialAsset: MarketAsset }) {
  const [limit, setLimit] = useState<number>(96);
  const [asset, setAssetState] = useState<MarketAsset>(initialAsset);
  const setAsset = (a: MarketAsset) => {
    setAssetState(a);
    window.history.replaceState(null, "", `/compare?asset=${a}`);
  };
  const st = useCompare(limit, asset);

  return (
    <div className="min-h-screen pb-16">
      <AppHeader active="compare" />
      <main className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 pt-6 sm:px-6 sm:pt-8">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Comparativa spot vs futures</h1>
            <p className="mt-1 text-sm text-muted-foreground">{ASSET_INFO[asset].name}: los mismos motores con Binance spot y con futures, en los mismos markets.</p>
          </div>
          <Segmented label="Activo" value={asset} onChange={setAsset} options={ASSETS.map((a) => ({ value: a, label: ASSET_INFO[a].ticker }))} />
        </div>

      <Panel
        id="compare.totals"
        title="Totales por motor"
        description={
          <>
            Markets guardados por las dos fuentes. <b>Adelanto</b> = hora de la primera entrada de spot − la de futures, cuando las dos
            entraron por el mismo lado (positivo: futures antes). <b>Precio entrada</b> = precio de spot − el de futures (positivo: futures
            compró más barato). P&L de papel.
          </>
        }
        actions={
          <Segmented
            label="Periodo"
            size="xs"
            value={String(limit)}
            onChange={(v) => setLimit(Number(v))}
            options={LIMITS.map((l) => ({ value: String(l), label: l === 288 ? "24 h" : `${(l * 5) / 60} h` }))}
          />
        }
      >
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
      </Panel>

      {st.status === "ready" && st.data.markets.length > 0 && (
        <Panel
          id="compare.markets"
          title={`Markets (${st.data.markets.length})`}
          description="Por motor: lado de la primera entrada spot / futures, adelanto y diferencia de precio, y P&L spot / futures."
        >
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
        </Panel>
      )}
      </main>
    </div>
  );
}
