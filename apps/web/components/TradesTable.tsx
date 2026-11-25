import type { AggTrade } from "@updown/protocol";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const ROWS = 100;
const WHALE_USD = 100_000;

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("es", { hour12: false }) + "." + String(ms % 1000).padStart(3, "0");

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtUsd = (v: number) => (v >= 1000 ? usd0.format(v) : usd2.format(v));

/** Tabla de los ultimos trades (mas reciente primero). Filas >= $100k resaltadas. */
export function TradesTable({ trades }: { trades: AggTrade[] }) {
  return (
    <div className="max-h-96 overflow-auto">
      <Table className="font-mono text-xs">
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>Hora</TableHead>
            <TableHead>Lado</TableHead>
            <TableHead className="text-right">Precio</TableHead>
            <TableHead className="text-right">Cantidad</TableHead>
            <TableHead className="text-right">Dólares</TableHead>
            <TableHead className="text-right">ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.slice(0, ROWS).map((t) => {
            const usd = t.price * t.quantity;
            return (
              <TableRow
                key={t.id}
                className={cn(t.isBuyerMaker ? "text-sell" : "text-buy", usd >= WHALE_USD && "bg-muted/60 font-bold")}
              >
                <TableCell>{fmtTime(t.time)}</TableCell>
                <TableCell>{t.isBuyerMaker ? "Venta" : "Compra"}</TableCell>
                <TableCell className="text-right">{t.price.toFixed(2)}</TableCell>
                <TableCell className="text-right">{t.quantity.toFixed(5)}</TableCell>
                <TableCell className="text-right">{fmtUsd(usd)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{t.id}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!trades.length && <p className="p-4 text-sm text-muted-foreground">Esperando datos…</p>}
    </div>
  );
}
