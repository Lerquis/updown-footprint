"use client";

import { useSyncExternalStore } from "react";
import type { ChartView } from "./chartView";

/** true cuando la vista tiene zoom/desplazamiento manual (para mostrar "Restablecer"). */
export function useChartViewCustom(view: ChartView): boolean {
  return useSyncExternalStore(
    view.subscribe,
    () => view.custom,
    () => false,
  );
}
