"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { CHANNELS, SOURCES, type MarketSource } from "@updown/protocol";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChartView } from "@/lib/chartView";
import { SIGNAL_INFO } from "@/lib/flow";
import { useAggTrades } from "@/lib/useAggTrades";
import { useChartViewCustom } from "@/lib/useChartViewCustom";
import { useDepth } from "@/lib/useDepth";
import { useOrderflow } from "@/lib/useOrderflow";
import { usePolymarket } from "@/lib/usePolymarket";
import { useLatency } from "@/lib/useLatency";
import { SOURCE_LABEL, SourceProvider, useSource, useStoredSource } from "@/lib/source";
import { BookmapChart } from "./BookmapChart";
import { CvdChart } from "./CvdChart";
import { FootprintPanel } from "./FootprintPanel";
import { HeatmapHelp } from "./HeatmapHelp";
import { HeatmapLegend } from "./HeatmapLegend";
import { LatencyPanel } from "./LatencyPanel";
import { LiveBadge } from "./LiveBadge";
import { PolymarketPanel } from "./PolymarketPanel";
import { TradesTable } from "./TradesTable";

const WINDOWS = [
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
] as const;

/** Panel completo de una fuente (spot o futures). Al cambiar de fuente se monta de nuevo: todo se conecta a la otra. */
export function SourceDashboard() {
  const [source, setSource] = useStoredSource();
  return (
    <SourceProvider source={source}>
      <MarketDashboard key={source} onSourceChange={setSource} />
    </SourceProvider>
  );
}

function SourceSwitch({ value, onChange }: { value: MarketSource; onChange: (s: MarketSource) => void }) {
  return (
    <ToggleGroup variant="outline" size="sm" spacing={0} value={[value]} onValueChange={(v) => v[0] && onChange(v[0] as MarketSource)}>
      {SOURCES.map((s) => (
        <ToggleGroupItem key={s} value={s}>
          {SOURCE_LABEL[s]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function MarketDashboard({ onSourceChange }: { onSourceChange: (s: MarketSource) => void }) {
  const source = useSource();
  const agg = useAggTrades();
  const depth = useDepth();
  const flow = useOrderflow();
  const pm = usePolymarket();
  const lat = useLatency();
  const pf = usePolymarket(CHANNELS.predict);
  const pfLat = useLatency(CHANNELS.predictLatency);

  // Vista (zoom/desplazamiento) compartida por la grafica de precio y la de CVD; vive fuera de React.
  const viewRef = useRef<ChartView | null>(null);
  if (!viewRef.current) viewRef.current = new ChartView(60_000, 15 * 60_000);
  const view = viewRef.current;
  view.maxMs = agg.retentionMs;
  const customView = useChartViewCustom(view);

  const [preset, setPreset] = useState<number>(60_000);
  const [heatmap, setHeatmap] = useState(true);
  const [bubbles, setBubbles] = useState(true);
  const [signals, setSignals] = useState(true);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">
            Updown Footprint {agg.symbol && <span className="ml-2 text-yellow-500">{agg.symbol}</span>}
            <span className="ml-2 text-sm font-normal text-muted-foreground">{source === "futures" ? "perpetuo USDⓈ-M" : "spot"}</span>
          </h1>
          <SourceSwitch value={source} onChange={onSourceChange} />
          <Link href="/compare" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Comparar spot vs futures
          </Link>
        </div>
        <div className="flex flex-wrap gap-2">
          <LiveBadge label="Trades" link={agg.link} upstream={agg.upstream} />
          <LiveBadge label="Libro" link={depth.link} upstream={depth.upstream} />
          <LiveBadge label="Flujo" link={flow.link} upstream={flow.upstream} />
        </div>
      </header>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-1">
            Mapa de liquidez, trades y flujo <HeatmapHelp />
          </CardTitle>
          <CardDescription>
            Dónde hay órdenes esperando (heatmap), qué se ha operado (burbujas) y qué señales deja el flujo. Memoria:{" "}
            {Math.round(agg.retentionMs / 60000)} min.
          </CardDescription>
          <CardAction className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch id="heat" size="sm" checked={heatmap} onCheckedChange={setHeatmap} />
              <Label htmlFor="heat">Heatmap</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="bub" size="sm" checked={bubbles} onCheckedChange={setBubbles} />
              <Label htmlFor="bub">Burbujas</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="sig" size="sm" checked={signals} onCheckedChange={setSignals} />
              <Label htmlFor="sig">Señales</Label>
            </div>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[String(preset)]}
              onValueChange={(v) => {
                if (!v[0]) return;
                const ms = Number(v[0]);
                setPreset(ms);
                view.setPreset(ms);
              }}
            >
              {WINDOWS.map((w) => (
                <ToggleGroupItem key={w.label} value={String(w.ms)}>
                  {w.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {customView && (
              <Button variant="outline" size="sm" onClick={() => view.reset()}>
                Restablecer vista
              </Button>
            )}
          </CardAction>
        </CardHeader>

        {heatmap && <HeatmapLegend />}
        {signals && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5 text-[11px] text-muted-foreground">
            <span>
              Señales: <b className="text-buy">▲ alcista</b> · <b className="text-sell">▼ bajista</b>
            </span>
            {Object.values(SIGNAL_INFO).map((s) => (
              <span key={s.short}>
                <b className="font-mono text-foreground">{s.short}</b> {s.label.toLowerCase()}
              </span>
            ))}
          </div>
        )}

        <CardContent className="p-0">
          <BookmapChart
            view={view}
            trades={agg.trades}
            columns={depth.columns}
            step={depth.step}
            signalList={flow.signals}
            barMs={flow.barMs}
            heatmap={heatmap}
            bubbles={bubbles}
            signals={signals}
          />
          <CvdChart view={view} points={flow.cvd} signalList={flow.signals} barMs={flow.barMs} showSignals={signals} />
          <p className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">
            Rueda: zoom del tiempo · Ctrl/Shift + rueda (o rueda sobre el eje de precio): zoom del precio · Arrastrar: mover · Doble
            clic: restablecer
          </p>
        </CardContent>
      </Card>

      <LatencyPanel lat={lat} />
      <PolymarketPanel pm={pm} flow={flow} />
      <LatencyPanel lat={pfLat} venue="predict" />
      <PolymarketPanel pm={pf} flow={flow} venue="predict" />
      <FootprintPanel bars={flow.bars} signals={flow.signals} />

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-3">
          <CardTitle>Últimos trades</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <TradesTable trades={agg.trades} />
        </CardContent>
      </Card>
    </main>
  );
}
