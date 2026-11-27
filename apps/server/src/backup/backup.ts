import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";
import { S3Lite, type S3Config, type S3Object } from "./s3.js";

/**
 * Backups de la base SQLite a un bucket S3 (Cloudflare R2 recomendado) y restauracion al arrancar.
 * - `snapshot`: copia consistente con `VACUUM INTO` en un hilo aparte (no bloquea el servidor; WAL permite leer mientras se escribe).
 * - Se comprime con gzip y se sube como `<prefix>polymarket-<fecha>.db.gz`; `<prefix>latest.json` apunta al ultimo.
 * - Cada hora, y otra vez al apagar (SIGTERM antes de cada deploy). Retencion: todo lo de las ultimas `keepHours` h + uno por dia UTC.
 * - `latest.json` (de donde se restaura) NUNCA retrocede: si una copia tiene menos markets que la anterior (la base se vacio,
 *   p. ej. el volumen se perdio), se sube igual pero el puntero no se mueve. Ver docs/guides/deployment.md y ADR 0013.
 */
export interface BackupConfig {
  s3: S3Config;
  /** carpeta de los backups dentro del bucket, p. ej. "updown/v2/" */
  prefix: string;
  /** carpeta del archivo final de bases anteriores, p. ej. "updown/archive/" */
  archivePrefix: string;
  /** cada cuanto se hace un backup */
  intervalMs: number;
  /** horas en que se conservan todas las copias; las mas antiguas se reducen a una por dia */
  keepHours: number;
}

export interface BackupItem {
  key: string;
  /** ms */
  lastModified: number;
}

const BACKUP_RE = /polymarket-[^/]*\.db\.gz$/;

/**
 * Copias a borrar: se conservan todas las de las ultimas `keepHours` h y, de las mas antiguas, la primera de cada dia UTC.
 * Nunca se borra la mas reciente ni nada que no sea `polymarket-*.db.gz` (latest.json, archivo, etc.).
 */
export function backupsToPrune(items: BackupItem[], now: number, keepHours: number): string[] {
  const backups = items.filter((i) => BACKUP_RE.test(i.key)).sort((a, b) => a.lastModified - b.lastModified);
  const newest = backups.at(-1)?.key;
  const keptDays = new Set<string>();
  const prune: string[] = [];
  for (const b of backups) {
    if (b.key === newest || now - b.lastModified < keepHours * 3600_000) continue;
    const day = new Date(b.lastModified).toISOString().slice(0, 10);
    if (keptDays.has(day)) prune.push(b.key);
    else keptDays.add(day);
  }
  return prune;
}

/** El puntero de restauracion solo avanza si la copia nueva no tiene menos markets que la que apunta (una base vaciada no lo pisa). */
export function shouldMoveLatest(prevMarkets: number | null | undefined, newMarkets: number): boolean {
  return prevMarkets == null || newMarkets >= prevMarkets;
}

/** Markets guardados en un archivo SQLite (0 si no hay tabla) */
function countMarkets(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM markets").get() as { n: number }).n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

const LATEST = "latest.json";

/** Copia consistente de la base con `VACUUM INTO`, en un worker thread con su propia conexion (solo lee). */
export function snapshot(dbPath: string, outPath: string): Promise<void> {
  const code = `
    const { workerData, parentPort } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.src);
    db.exec("PRAGMA busy_timeout = 10000");
    try { db.prepare("VACUUM INTO ?").run(workerData.out); } finally { db.close(); }
    parentPort.postMessage("ok");
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { src: dbPath, out: outPath } });
    w.once("message", () => resolve());
    w.once("error", reject);
    w.once("exit", (c) => (c === 0 ? resolve() : reject(new Error(`snapshot worker exit ${c}`))));
  });
}

const gzip = (from: string, to: string) => pipeline(createReadStream(from), createGzip({ level: 6 }), createWriteStream(to));
const gunzip = (from: string, to: string) => pipeline(createReadStream(from), createGunzip(), createWriteStream(to));
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export class DbBackup {
  private readonly s3: S3Lite;
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: Promise<{ key: string; bytes: number; markets: number }> | null = null;
  /** ultimo fallo (se muestra en /health para no depender de los logs) */
  lastError: { at: string; message: string } | null = null;
  /** archivo en el mismo volumen que la base con la fecha del ultimo backup correcto */
  private readonly stampFile: string;
  private readonly tmpDir: string;

  constructor(
    private readonly cfg: BackupConfig,
    private readonly dbPath: string,
  ) {
    this.s3 = new S3Lite(cfg.s3);
    this.stampFile = `${dbPath}.last-backup`;
    this.tmpDir = join(dirname(dbPath), "backup-tmp");
  }

  private key(name: string) {
    return `${this.cfg.prefix}${name}`;
  }

  /** ms del ultimo backup correcto (0 si nunca) */
  lastBackup(): number {
    try {
      return Number(readFileSync(this.stampFile, "utf8")) || 0;
    } catch {
      return 0;
    }
  }

  get running(): boolean {
    return this.current !== null;
  }

  /** Hace un backup ahora (si ya hay uno en curso, devuelve ese): snapshot → gzip → subida → puntero → retencion. */
  run(): Promise<{ key: string; bytes: number; markets: number }> {
    this.current ??= this.doRun()
      .then((r) => {
        this.lastError = null;
        return r;
      })
      .catch((e: unknown) => {
        this.lastError = { at: new Date().toISOString(), message: e instanceof Error ? e.message : String(e) };
        throw e;
      })
      .finally(() => (this.current = null));
    return this.current;
  }

  private async doRun(): Promise<{ key: string; bytes: number; markets: number }> {
    const t0 = Date.now();
    const raw = join(this.tmpDir, "snapshot.db");
    const gz = `${raw}.gz`;
    try {
      await rm(this.tmpDir, { recursive: true, force: true });
      mkdirSync(this.tmpDir, { recursive: true });
      await snapshot(this.dbPath, raw);
      const markets = countMarkets(raw);
      await gzip(raw, gz);
      const bytes = (await stat(gz)).size;
      const key = this.key(`polymarket-${new Date().toISOString().replace(/[:.]/g, "-")}.db.gz`);
      await this.s3.putFile(key, gz);
      const prev = await this.s3
        .getText(this.key(LATEST))
        .then((t) => (t ? (JSON.parse(t) as { markets?: number }) : null))
        .catch(() => null);
      if (shouldMoveLatest(prev?.markets, markets)) {
        await this.s3.putBuffer(this.key(LATEST), Buffer.from(JSON.stringify({ key, bytes, markets, at: Date.now() })), "application/json");
      } else {
        console.error(`[backup] !!! la copia tiene ${markets} markets y la anterior ${prev?.markets}: la base parece vaciada. Se sube pero latest.json NO se mueve.`);
      }
      writeFileSync(this.stampFile, String(Date.now()));
      console.log(`[backup] ${key} (${mb(bytes)} comprimido, ${markets} markets) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await this.prune().catch((e) => console.error(`[backup] retencion: ${e instanceof Error ? e.message : e}`));
      return { key, bytes, markets };
    } finally {
      await rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Borra las copias que sobran segun la retencion (`backupsToPrune`). Solo dentro de `prefix`. */
  private async prune(): Promise<void> {
    const items: S3Object[] = await this.s3.list(this.cfg.prefix);
    const doomed = backupsToPrune(items, Date.now(), this.cfg.keepHours);
    for (const k of doomed) await this.s3.delete(k);
    if (doomed.length) console.log(`[backup] retencion: ${doomed.length} copias antiguas borradas`);
  }

  /**
   * Sube UNA vez una copia de otra base (la de la generacion anterior) a `archivePrefix<nombre>.db.gz` y deja una marca
   * `<base>.archived` al lado para no repetirlo. No borra ni modifica esa base. Devuelve la clave o null si no habia nada que archivar.
   */
  async archiveOnce(srcPath: string, label: string): Promise<string | null> {
    const mark = `${srcPath}.archived`;
    if (!existsSync(srcPath) || existsSync(mark)) return null;
    const t0 = Date.now();
    const dir = join(dirname(srcPath), "archive-tmp");
    const raw = join(dir, "archive.db");
    const gz = `${raw}.gz`;
    try {
      await rm(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await snapshot(srcPath, raw);
      await gzip(raw, gz);
      const bytes = (await stat(gz)).size;
      const key = `${this.cfg.archivePrefix}polymarket-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.db.gz`;
      await this.s3.putFile(key, gz);
      writeFileSync(mark, JSON.stringify({ key, bytes, at: Date.now() }));
      console.log(`[backup] base anterior archivada en ${key} (${mb(bytes)}) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return key;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Programa backups cada `intervalMs` (comprueba cada 10 min; el primero, si toca, 2 min despues de arrancar). */
  start(): void {
    const tick = () => {
      if (this.running || Date.now() - this.lastBackup() < this.cfg.intervalMs) return;
      this.run().catch((e) => console.error(`[backup] fallo: ${e instanceof Error ? e.message : e}`));
    };
    setTimeout(tick, 2 * 60_000).unref();
    this.timer = setInterval(tick, 10 * 60_000);
    this.timer.unref();
    console.log(`[backup] activo: s3://${this.cfg.s3.bucket}/${this.cfg.prefix} cada ${this.cfg.intervalMs / 3600_000} h`);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Si la base no existe, la descarga del ultimo backup (`latest.json`, o `key` concreto).
   * Devuelve true si restauro. Nunca sobrescribe una base existente.
   */
  async restoreIfMissing(key?: string): Promise<boolean> {
    if (existsSync(this.dbPath)) return false;
    let target = key;
    if (!target) {
      const latest = await this.s3.getText(this.key(LATEST));
      if (!latest) {
        console.log("[backup] no hay base local ni backup previo: se empieza una base nueva");
        return false;
      }
      target = (JSON.parse(latest) as { key: string }).key;
    }
    const t0 = Date.now();
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const gz = `${this.dbPath}.restore.gz`;
    const tmp = `${this.dbPath}.restore`;
    try {
      await this.s3.getToFile(target, gz);
      await gunzip(gz, tmp);
      await rename(tmp, this.dbPath);
      console.log(`[backup] base restaurada desde ${target} (${mb((await stat(this.dbPath)).size)}) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return true;
    } finally {
      await rm(gz, { force: true });
      await rm(tmp, { force: true });
    }
  }
}
