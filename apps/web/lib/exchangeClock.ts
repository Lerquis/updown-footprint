/**
 * Reloj del exchange estimado en el navegador.
 * Los timestamps de trades y de columnas vienen del reloj de Binance; el del PC puede estar
 * desfasado varios segundos. offset = trade.time - Date.now() al recibir (= desfase - latencia),
 * y tomamos el maximo de las ultimas muestras (la de menor latencia).
 */
const WINDOW = 100;
const samples: number[] = [];
let offset = 0;

export const exchangeClock = {
  observe(exchangeTime: number): void {
    samples.push(exchangeTime - Date.now());
    if (samples.length > WINDOW) samples.shift();
    offset = Math.max(...samples);
  },
  now(): number {
    return Date.now() + offset;
  },
};
