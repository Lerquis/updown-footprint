"use client";

import { CircleQuestionMark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BUY_GRADIENT, SELL_GRADIENT } from "@/lib/heatmapPalette";

function Swatch({ gradient }: { gradient: string }) {
  return <span className="mt-1 inline-block h-3 w-16 shrink-0 rounded-sm" style={{ background: gradient }} />;
}

/** Boton "?" que abre un modal explicando como leer el heatmap. */
export function HeatmapHelp() {
  return (
    <Dialog>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="¿Cómo se lee el mapa de liquidez?" />}
      >
        <CircleQuestionMark />
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>¿Cómo se lee el mapa de liquidez?</DialogTitle>
          <DialogDescription>
            Es una foto del libro de órdenes de Binance a lo largo del tiempo: muestra dónde hay dinero esperando para
            comprar o vender.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <section className="space-y-1">
            <h3 className="font-semibold">Los ejes</h3>
            <p className="text-muted-foreground">
              Horizontal: el tiempo (lo más reciente a la derecha). Vertical: el precio. Cada celda de color es un nivel
              de precio en un segundo concreto.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">Los colores</h3>
            <div className="flex gap-3">
              <Swatch gradient={BUY_GRADIENT} />
              <p>
                <b className="text-buy">Verde: zona de compra.</b> Órdenes de compra pendientes, siempre{" "}
                <i>debajo</i> del precio. Funcionan como un posible &quot;suelo&quot;: si el precio baja hasta ahí, hay
                quien quiere comprar.
              </p>
            </div>
            <div className="flex gap-3">
              <Swatch gradient={SELL_GRADIENT} />
              <p>
                <b className="text-sell">Rojo: zona de venta.</b> Órdenes de venta pendientes, siempre <i>encima</i>{" "}
                del precio. Funcionan como un posible &quot;techo&quot;: si el precio sube hasta ahí, hay quien quiere
                vender.
              </p>
            </div>
            <p className="text-muted-foreground">
              La intensidad indica cuánta liquidez hay: oscuro = poca, brillante = mucha. Un color casi blanco es una{" "}
              <b className="text-foreground">zona caliente</b>: una &quot;pared&quot; de órdenes mucho mayor que el
              resto. La gráfica la rotula como <i>Zona caliente de compra</i> o <i>de venta</i> con su tamaño.
            </p>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold">Lo que se dibuja encima</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                <b className="text-foreground">Línea blanca:</b> el precio de los trades. Línea amarilla punteada: último
                precio.
              </li>
              <li>
                <b className="text-foreground">Burbujas:</b> operaciones ya ejecutadas. Su tamaño es el dinero en dólares;
                verde = compra agresora, rojo = venta agresora.
              </li>
            </ul>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold">Cómo interpretarlo</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>El precio suele frenarse o rebotar al llegar a una zona caliente, pero no es una garantía.</li>
              <li>
                Si el precio <i>atraviesa</i> una pared y las burbujas grandes se pegan a ella, la pared fue absorbida o
                rota.
              </li>
              <li>
                Una pared que <i>desaparece</i> antes de que el precio llegue era una orden cancelada. Las órdenes son
                intenciones, no operaciones, y pueden retirarse (a veces para engañar).
              </li>
            </ul>
          </section>

          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            Alcance: solo se muestra el precio ±0,1 % y los últimos 15 minutos. La liquidez está en cantidad de activo
            (BTC o ETH); el color se escala con lo que hay visible en pantalla, así que compara zonas dentro de la misma vista,
            no entre ventanas de tiempo distintas.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
