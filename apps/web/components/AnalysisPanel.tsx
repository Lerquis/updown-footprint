"use client";

import { SCENARIOS, type MarketSummary, type ScenarioBias } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BIAS_LABEL, TREND_LABEL, biasText, fmtClockHMS, trendArrow } from "@/lib/flow";
import type { AnalysisView } from "@/lib/useAnalysis";
import { cn } from "@/lib/utils";
import { FlowGuide } from "./FlowGuide";

const BY_ID = new Map(SCENARIOS.map((s) => [s.id as string, s]));
const dot = (b: ScenarioBias) => (b === "bullish" ? "bg-buy" : b === "bearish" ? "bg-sell" : "bg-muted-foreground");

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-sm font-semibold", tone)}>{value}</div>
      {sub && <div className="font-mono text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Barra -100..100 centrada en 0. */
function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.abs(score)) / 2;
  return (
    <div className="relative h-2 w-full rounded-full bg-muted">
      <div className="absolute left-1/2 top-0 h-full w-px bg-foreground/40" />
      <div
        className={cn("absolute top-0 h-full rounded-full", score >= 0 ? "bg-buy" : "bg-sell")}
        style={score >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </div>
  );
}

const trendTone = (t: "up" | "down" | "flat") => (t === "up" ? "text-buy" : t === "down" ? "text-sell" : "text-muted-foreground");
const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

function Reading({ s }: { s: MarketSummary }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <Badge variant="outline" className={cn("h-6 px-3 text-sm", biasText(s.bias), s.bias === "bullish" ? "border-buy/50" : s.bias === "bearish" ? "border-sell/50" : "")}>
          {BIAS_LABEL[s.bias]}
        </Badge>
        <div className="flex-1">
          <ScoreBar score={s.score} />
          <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
            <span>bajista</span>
            <span className="font-mono">{signed(s.score, 0)}</span>
            <span>alcista</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric
          label={`Precio (${Math.round(s.lookbackMs / 60000)} min)`}
          value={`${trendArrow(s.priceTrend)} ${TREND_LABEL[s.priceTrend]}`}
          sub={`${signed(s.priceChange)} USDT`}
          tone={trendTone(s.priceTrend)}
        />
        <Metric
          label={`CVD (${Math.round(s.lookbackMs / 60000)} min)`}
          value={`${trendArrow(s.cvdTrend)} ${TREND_LABEL[s.cvdTrend]}`}
          sub={signed(s.cvdChange, 3)}
          tone={trendTone(s.cvdTrend)}
        />
        <Metric label="Delta barra actual" value={signed(s.barDelta, 3)} tone={s.barDelta >= 0 ? "text-buy" : "text-sell"} />
        <Metric label="Señales recientes" value={String(s.signalIds.length)} sub={`actualizado ${fmtClockHMS(s.time)}`} />
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lectura actual</h3>
        {s.scenarios.map((m, i) => {
          const def = BY_ID.get(m.id);
          if (!def) return null;
          return (
            <div key={m.id} className={cn("rounded-md border p-2.5", i === 0 && "border-foreground/30 bg-muted/30")}>
              <div className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", dot(def.bias))} />
                <span className="text-sm font-medium">{def.title}</span>
                <span className="ml-auto font-mono text-xs tracking-widest text-muted-foreground" title={`importancia ${m.weight}/3`}>
                  {"●".repeat(m.weight)}
                  {"○".repeat(3 - m.weight)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{def.meaning}</p>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Monitor de flujo: tendencias + señales => escenarios activos, y registro de cambios de lectura. */
export function AnalysisPanel({ analysis }: { analysis: AnalysisView }) {
  const { summary, history } = analysis;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-3">
        <CardTitle className="flex items-center gap-1">
          Monitor de flujo <FlowGuide />
        </CardTitle>
        <CardDescription>Interpreta CVD + footprint + precio. Lectura automática, no recomendación de inversión.</CardDescription>
        <CardAction />
      </CardHeader>
      <CardContent className="grid gap-4 py-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {summary ? <Reading s={summary} /> : <p className="text-sm text-muted-foreground">Calculando… (se necesitan unos segundos de datos)</p>}
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cambios de lectura</h3>
          <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
            {[...history].reverse().map((h) => {
              const top = BY_ID.get(h.scenarios[0]?.id ?? "");
              return (
                <div key={h.time} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">{fmtClockHMS(h.time)}</span>
                    <span className={cn("font-medium", biasText(h.bias))}>{BIAS_LABEL[h.bias]}</span>
                    <span className="ml-auto font-mono text-muted-foreground">{signed(h.score, 0)}</span>
                  </div>
                  <div className="text-muted-foreground">{top?.title ?? "—"}</div>
                </div>
              );
            })}
            {!history.length && <p className="text-xs text-muted-foreground">Sin cambios todavía.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
