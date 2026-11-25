import type { ChartView } from "./chartView";

/**
 * Zoom y desplazamiento sobre un canvas ligado a un ChartView.
 *  - Rueda: zoom del tiempo anclado bajo el cursor.
 *  - (solo `priceAxis`) Ctrl/Shift + rueda, o rueda sobre el eje derecho: zoom del precio.
 *  - Arrastrar: mover en el tiempo (y en el precio si `priceAxis`).
 *  - Doble clic: restablecer vista.
 * Devuelve la funcion de limpieza.
 */
export function attachViewInteractions(
  canvas: HTMLCanvasElement,
  view: ChartView,
  plot: () => { pw: number; ph: number },
  priceAxis: boolean,
): () => void {
  let drag: { x: number; y: number } | null = null;
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const { pw, ph } = plot();
    const factor = Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015);
    if (priceAxis && (x > pw || e.ctrlKey || e.shiftKey)) view.zoomPrice(factor, Math.min(1, Math.max(0, y / ph)));
    else view.zoomTime(factor, Math.min(1, Math.max(0, x / pw)));
  };
  const onDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    const { pw, ph } = plot();
    if (dx) view.panTime((-dx / pw) * view.winMs);
    if (priceAxis && dy) {
      const span = view.priceSpan ?? view.lastRange.hi - view.lastRange.lo;
      view.panPrice((dy / ph) * span);
    }
  };
  const onUp = (e: PointerEvent) => {
    drag = null;
    canvas.style.cursor = "grab";
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  const onDbl = () => view.reset();

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("dblclick", onDbl);
  return () => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("dblclick", onDbl);
  };
}
