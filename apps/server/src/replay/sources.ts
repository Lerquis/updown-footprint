import type { S3Object } from "../backup/s3.js";

/**
 * Que copias del bucket se usan para los replays (docs/features/replays.md). Funciones puras.
 *
 * Copias horarias (`<carpeta>polymarket-<fecha>.db.gz`): cada una es la base entera en ese momento, asi que basta la
 * ultima... salvo si la base se vacio (deploy sin volumen): entonces la copia anterior a la caida tiene markets que las
 * siguientes no. Se toma la ultima copia de cada tramo (antes de cada caida brusca de tamano) y la mas reciente.
 * Solo cuentan los objetos directamente en `folder` (no los de subcarpetas como `v2/` o `archive/`).
 *  - v1: `<prefijo>` (antes de la generacion v2 los backups iban a la raiz del prefijo, sin carpeta `v1/`)
 *  - v2: `<prefijo>v2/`
 */
export function pickSnapshots(objects: S3Object[], folder: string, dropRatio = 0.8): S3Object[] {
  const items = objects
    .filter((o) => o.key.startsWith(folder) && /^polymarket-[^/]+\.db\.gz$/.test(o.key.slice(folder.length)))
    .sort((a, b) => a.lastModified - b.lastModified);
  return items.filter((o, i) => i === items.length - 1 || items[i + 1]!.size < o.size * dropRatio);
}

/**
 * Archivo final de la base v1 (`<prefijo>archive/polymarket-<railway|local>-<fecha>.db.gz`): solo el del servidor
 * remoto (railway); el subido desde el PC (`-local-`) es la base local.
 */
export function pickV1Archives(objects: S3Object[]): S3Object[] {
  return objects.filter((o) => /\/polymarket-railway-[^/]+\.db\.gz$/.test(o.key)).sort((a, b) => b.lastModified - a.lastModified);
}
