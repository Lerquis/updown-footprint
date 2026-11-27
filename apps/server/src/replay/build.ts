import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { PmRecord, PmReplayMarket, PmReplayReport, PmReplaySource } from "@updown/protocol";
import { config } from "../config.js";
import { S3Lite, type S3Object } from "../backup/s3.js";
import { replayRecordDelayed } from "../polymarket/replay.js";
import { serverStrategy } from "../polymarket/serverStrategy.js";
import { pickSnapshots, pickV1Archives } from "./sources.js";

/**
 * Informe de replays del motor A con ejecucion retrasada (docs/features/replays.md):
 *   npm run replays -w @updown/server
 * Descarga de R2 las bases v1 (archivo del servidor remoto) y v2 (copias horarias), sin usar las bases locales,
 * reproduce el motor A en cada market (una vez por market, aunque este en varias copias) y escribe
 * `<REPLAY_DIR>/report.json`, que el servidor sirve en GET /api/replays.
 */
const DELAYS = [0, 1, 2, 3];

const s3cfg = config.backup.s3;
if (!s3cfg.endpoint || !s3cfg.bucket || !s3cfg.accessKeyId || !s3cfg.secretAccessKey) {
  console.error("[replays] faltan BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY en apps/server/.env.local");
  process.exit(1);
}
const s3 = new S3Lite(s3cfg);
const srcDir = join(config.replayDir, "src");
mkdirSync(srcDir, { recursive: true });

/** Descarga y descomprime una copia (se reutiliza si ya esta descargada con el mismo tamano). */
async function fetchDb(o: S3Object): Promise<string> {
  const gz = join(srcDir, basename(o.key));
  const db = gz.replace(/\.gz$/, "");
  if (existsSync(db) && existsSync(gz) && statSync(gz).size === o.size) return db;
  console.log(`[replays] descargando ${o.key} (${(o.size / 1e6).toFixed(1)} MB)`);
  await s3.getToFile(o.key, `${gz}.part`);
  renameSync(`${gz}.part`, gz);
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(`${db}.part`));
  renameSync(`${db}.part`, db);
  return db;
}

const strategy = serverStrategy();
const seen = new Set<string>();
const markets: PmReplayMarket[] = [];
const sources: PmReplaySource[] = [];

/** Lee los markets de una copia; cada market se reproduce solo la primera vez que aparece (las copias van de mas a menos prioridad). */
function addFrom(file: string, o: S3Object, generation: "v1" | "v2"): void {
  const db = new DatabaseSync(file, { readOnly: true });
  let added = 0;
  try {
    const rows = db.prepare("SELECT slug, data FROM markets ORDER BY start").all() as { slug: string; data: string }[];
    for (const row of rows) {
      if (seen.has(row.slug)) continue;
      const rec = JSON.parse(row.data) as PmRecord;
      if (rec.market.result === null || !rec.points.length) continue;
      seen.add(row.slug);
      markets.push(replayRecordDelayed(rec, generation, DELAYS, strategy));
      added++;
    }
  } finally {
    db.close();
  }
  sources.push({ generation, key: o.key, size: o.size, lastModified: o.lastModified, markets: added });
  console.log(`[replays] ${o.key}: ${added} markets nuevos`);
}

const all = await s3.list(config.backup.rootPrefix);
console.log(`[replays] ${all.length} objetos en s3://${s3cfg.bucket}/${config.backup.rootPrefix}:`);
for (const o of [...all].sort((a, b) => a.key.localeCompare(b.key))) console.log(`[replays]   ${o.key}  ${(o.size / 1e6).toFixed(1)} MB  ${new Date(o.lastModified).toISOString()}`);
// la mas reciente primero (tiene prioridad si un market esta en varias copias)
const v2 = pickSnapshots(all, config.backup.prefix).reverse();
// v1: archivo final del servidor remoto + copias horarias de la raiz (antes de la generacion v2 no habia carpeta v1/)
const v1 = [...pickV1Archives(all), ...pickSnapshots(all, config.backup.rootPrefix).reverse()];
if (!v2.length && !v1.length) {
  console.error(`[replays] no hay copias en s3://${s3cfg.bucket}/${config.backup.rootPrefix}`);
  process.exit(1);
}
for (const o of v2) addFrom(await fetchDb(o), o, "v2");
for (const o of v1) addFrom(await fetchDb(o), o, "v1");

markets.sort((a, b) => a.start - b.start);
const report: PmReplayReport = { engine: "a", delays: DELAYS, sources, markets };
const out = join(config.replayDir, "report.json");
writeFileSync(`${out}.part`, JSON.stringify(report));
renameSync(`${out}.part`, out);
const withTrades = markets.filter((m) => m.runs[0]!.fills.length > 0).length;
console.log(`[replays] ${markets.length} markets (${withTrades} con operaciones) → ${out}`);
for (const [i, d] of DELAYS.entries()) {
  const net = markets.reduce((s, m) => s + (m.runs[i]!.pnl.net ?? 0), 0);
  const inv = markets.reduce((s, m) => s + m.runs[i]!.pnl.invested, 0);
  console.log(`[replays]   +${d} s: invertido ${inv.toFixed(2)} · neto ${net.toFixed(2)}`);
}
