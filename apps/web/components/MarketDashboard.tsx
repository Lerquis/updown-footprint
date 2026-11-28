"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Columns2, Rows2 } from "lucide-react";
// [PREDICT desactivado] import { CHANNELS, ASSETS, SOURCES, type MarketAsset, type MarketSource } from "@updown/protocol";
import { ASSETS, SOURCES, type MarketAsset, type MarketSource } from "@updown/protocol";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ChartView } from "@/lib/chartView";
import { SIGNAL_INFO } from "@/lib/flow";
import { useAggTrades } from "@/lib/useAggTrades";
import { useChartViewCustom } from "@/lib/useChartViewCustom";
import { useDepth } from "@/lib/useDepth";
import { useOrderflow } from "@/lib/useOrderflow";
import { usePolymarket } from "@/lib/usePolymarket";
import { useLatency } from "@/lib/useLatency";
import { ASSET_INFO, SOURCE_LABEL, SourceProvider, useAsset, useSource, useStoredSource } from "@/lib/source";
import { useStored } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { AppHeader } from "./AppHeader";
import { BookmapChart } from "./BookmapChart";
import { CvdChart } from "./CvdChart";
import { FootprintPanel } from "./FootprintPanel";
import { HeatmapHelp } from "./HeatmapHelp";
import { HeatmapLegend } from "./HeatmapLegend";
import { LatencyPanel } from "./LatencyPanel";
import { LiveBadge } from "./LiveBadge";
import { Panel } from "./Panel";
import { PolymarketPanel } from "./PolymarketPanel";
import { Segmented } from "./Segmented";
import { TradesTable } from "./TradesTable";

const WINDOWS = [
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
] as const;

const LAYOUTS = ["stack", "split"] as const;
type Layout = (typeof LAYOUTS)[number];
const OPEN = ["open", "closed"] as const;

const price = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Pagina principal: BTC y ETH (ADR 0018), cada uno con su fuente (spot/futures) y todos sus bloques plegables.
 * En pantallas muy anchas se pueden ver lado a lado.
 */
export function HomeDashboard() {
  const [layout, setLayout] = useStored<Layout>("updown.layout", "stack", LAYOUTS);
  return (
    <div className="min-h-screen pb-16">
      <AppHeader active="panel">
        <Segmented
          label="Distribución"
          className="hidden 2xl:inline-flex"
          value={layout}
          onChange={setLayout}
          options={[
            { value: "stack", label: <Rows2 aria-label="Apilado" />, title: "Un activo debajo del otro" },
            { value: "split", label: <Columns2 aria-label="Lado a lado" />, title: "BTC y ETH lado a lado" },
          ]}
        />
      </AppHeader>
      <main className="mx-auto max-w-[1680px] px-3 pt-6 sm:px-6 sm:pt-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Panel de mercado</h1>
            <p className="mt-1 text-sm text-muted-foreground">Orderflow de Binance y markets Up/Down 5m de Polymarket, en vivo.</p>
          </div>
          <nav className="flex items-center gap-2" aria-label="Activos">
            {ASSETS.map((a) => (
              <a
                key={a}
                href={`#${a}`}
                className="inline-flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-xs font-semibold transition-colors hover:bg-muted"
              >
                <span className="grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground">{ASSET_INFO[a].glyph}</span>
                {ASSET_INFO[a].ticker}
              </a>
            ))}
          </nav>
        </div>
        <div className={cn("grid gap-8", layout === "split" && "2xl:grid-cols-2 2xl:gap-6")}>
          {ASSETS.map((a) => (
            <AssetDashboard key={a} asset={a} />
          ))}
        </div>
      </main>
    </div>
  );
}

/** Un activo: al cambiar de fuente se monta de nuevo y todo se conecta a la otra. */
function AssetDashboard({ asset }: { asset: MarketAsset }) {
  const [source, setSource] = useStoredSource(asset);
  return (
    <SourceProvider asset={asset} source={source}>
      <MarketDashboard key={source} onSourceChange={setSource} />
    </SourceProvider>
  );
}

function MarketDashboard({ onSourceChange }: { onSourceChange: (s: MarketSource) => void }) {
  const source = useSource();
  const asset = useAsset();
  const info = ASSET_INFO[asset];
  const agg = useAggTrades();
  const depth = useDepth();
  const flow = useOrderflow();
  const pm = usePolymarket();
  const lat = useLatency();
  // [PREDICT desactivado] Predict esta comentado entero (ADR 0017): sin estos hooks no se abre ningun WS de Predict.
  // [PREDICT desactivado] const pf = usePolymarket(CHANNELS.predict);
  // [PREDICT desactivado] const pfLat = useLatency(CHANNELS.predictLatency);

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
  const [section, setSection] = useStored(`updown.panel.${asset}`, "open", OPEN);
  const open = section === "open";
  const last = agg.trades[0];

  return (
    <section id={asset} className="flex min-w-0 scroll-mt-20 flex-col gap-4">
      {/* Cabecera del activo */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl border bg-card px-4 py-4 shadow-xs sm:px-5">
        <button
          type="button"
          onClick={() => setSection(open ? "closed" : "open")}
          aria-expanded={open}
          title={open ? `Plegar ${info.name}` : `Desplegar ${info.name}`}
          className="flex min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-xl font-semibold text-primary-foreground">{info.glyph}</span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              {info.name}
              <span className="font-mono text-xs font-medium text-muted-foreground">{agg.symbol || info.pair}</span>
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
            </span>
            <span className="block font-mono text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{last ? price(last.price) : "–"}</span>
          </span>
        </button>
        <div className="flex flex-col gap-1.5">
          <Segmented label={`Fuente de ${info.ticker}`} value={source} onChange={onSourceChange} options={SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))} />
          <span className="pl-1 text-[11px] text-muted-foreground">{source === "futures" ? "perpetuo USDⓈ-M" : "spot"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <LiveBadge label="Trades" link={agg.link} upstream={agg.upstream} />
          <LiveBadge label="Libro" link={depth.link} upstream={depth.upstream} />
          <LiveBadge label="Flujo" link={flow.link} upstream={flow.upstream} />
          <Link
            href={`/compare?asset=${asset}`}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
          >
            Comparar spot vs futures <ArrowUpRight className="size-3" />
          </Link>
        </div>
      </div>

      {open && (
        <>
          <Panel
            id={`${asset}.map`}
            title="Mapa de liquidez, trades y flujo"
            titleExtra={<HeatmapHelp />}
            description={
              <>
                Dónde hay órdenes esperando (heatmap), qué se ha operado (burbujas) y qué señales deja el flujo. Memoria:{" "}
                {Math.round(agg.retentionMs / 60000)} min.
              </>
            }
            toolbar={
              <>
                <div className="flex items-center gap-2">
                  <Switch id={`${asset}-heat`} size="sm" checked={heatmap} onCheckedChange={setHeatmap} />
                  <Label htmlFor={`${asset}-heat`}>Heatmap</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id={`${asset}-bub`} size="sm" checked={bubbles} onCheckedChange={setBubbles} />
                  <Label htmlFor={`${asset}-bub`}>Burbujas</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id={`${asset}-sig`} size="sm" checked={signals} onCheckedChange={setSignals} />
                  <Label htmlFor={`${asset}-sig`}>Señales</Label>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {customView && (
                    <Button variant="outline" size="sm" className="rounded-full" onClick={() => view.reset()}>
                      Restablecer vista
                    </Button>
                  )}
                  <Segmented
                    label="Ventana de tiempo"
                    size="xs"
                    value={String(preset)}
                    onChange={(v) => {
                      const ms = Number(v);
                      setPreset(ms);
                      view.setPreset(ms);
                    }}
                    options={WINDOWS.map((w) => ({ value: String(w.ms), label: w.label }))}
                  />
                </div>
              </>
            }
          >
            {heatmap && <HeatmapLegend />}
            {signals && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
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
            <div className="p-2 sm:p-3">
              <div className="overflow-hidden rounded-xl bg-screen ring-1 ring-foreground/10">
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
              </div>
            </div>
            <p className="px-4 pb-3 text-[11px] text-muted-foreground sm:px-5">
              Rueda: zoom del tiempo · Ctrl/Shift + rueda (o rueda sobre el eje de precio): zoom del precio · Arrastrar: mover · Doble
              clic: restablecer
            </p>
          </Panel>

          <LatencyPanel lat={lat} />
          <PolymarketPanel pm={pm} flow={flow} />
          {/* [PREDICT desactivado] <LatencyPanel lat={pfLat} venue="predict" /> */}
          {/* [PREDICT desactivado] <PolymarketPanel pm={pf} flow={flow} venue="predict" /> */}
          <FootprintPanel bars={flow.bars} signals={flow.signals} />

          <Panel id={`${asset}.trades`} title="Últimos trades" defaultOpen={false}>
            <TradesTable trades={agg.trades} />
          </Panel>
        </>
      )}
    </section>
  );
}
