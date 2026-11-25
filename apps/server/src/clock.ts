/**
 * Reloj sincronizado con Binance: el del PC puede estar desfasado segundos. Se calibra con el
 * timestamp de cada trade en vivo (`observe`); offset = exchangeTime - Date.now() = desfase - latencia,
 * y se toma el maximo de las ultimas muestras (la de menor latencia). Misma idea que el reloj del navegador.
 */
const WINDOW = 100;

export class ExchangeClock {
  private samples: number[] = [];
  private offset = 0;

  observe(exchangeTime: number): void {
    this.samples.push(exchangeTime - Date.now());
    if (this.samples.length > WINDOW) this.samples.shift();
    this.offset = Math.max(...this.samples);
  }

  now(): number {
    return Date.now() + this.offset;
  }
}
