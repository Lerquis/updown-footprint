import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";
import { S3Lite, type S3Config } from "./s3.js";

/**
 * Backups de la base SQLite a un bucket S3 (Cloudflare R2 recomendado) y restauracion al arrancar.
 * - `snapshot`: copia consistente con `VACUUM INTO` en un hilo aparte (no bloquea el servidor; WAL permite leer mientras se escribe).
 * - Se comprime con gzip y se sube como `<prefix>polymarket-<fecha>.db.gz`; `<prefix>latest.json` apunta al ultimo.
 * Ver docs/guides/deployment.md.
 */
export interface BackupConfig {
  s3: S3Config;
  /** carpeta dentro del bucket, p. ej. "updown/" */
  prefix: string;
  /** cada cuanto se hace un backup */
  intervalMs: number;
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
  private running = false;
  /** archivo en el mismo volumen que la base con la fecha del ultimo backup correcto */
  private readonly stampFile: string;
  private readonly tmpDir: string;

  constructor(
    private readonly cfg: BackupConfig,
    private readonly dbPath: string,
  ) {
    this.s3 = new S3Lite(cfg.s3);
    this.stampFile = join(dirname(dbPath), ".last-backup");
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

  /** Hace un backup ahora: snapshot → gzip → subida → puntero `latest.json`. */
  async run(): Promise<{ key: string; bytes: number }> {
    if (this.running) throw new Error("backup ya en curso");
    this.running = true;
    const t0 = Date.now();
    const raw = join(this.tmpDir, "snapshot.db");
    const gz = `${raw}.gz`;
    try {
      await rm(this.tmpDir, { recursive: true, force: true });
      mkdirSync(this.tmpDir, { recursive: true });
      await snapshot(this.dbPath, raw);
      await gzip(raw, gz);
      const bytes = (await stat(gz)).size;
      const key = this.key(`polymarket-${new Date().toISOString().replace(/[:.]/g, "-")}.db.gz`);
      await this.s3.putFile(key, gz);
      await this.s3.putBuffer(this.key(LATEST), Buffer.from(JSON.stringify({ key, bytes, at: Date.now() })), "application/json");
      writeFileSync(this.stampFile, String(Date.now()));
      console.log(`[backup] ${key} (${mb(bytes)} comprimido) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { key, bytes };
    } finally {
      await rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined);
      this.running = false;
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
