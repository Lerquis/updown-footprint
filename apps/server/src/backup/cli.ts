import { config } from "../config.js";
import { DbBackup } from "./backup.js";

/**
 * Backup / restauracion manual (lee las mismas variables BACKUP_* que el servidor, p. ej. de .env.local):
 *   npm run backup -w @updown/server              → sube un backup de PM_DB_PATH
 *   npm run backup -w @updown/server -- restore   → descarga el ultimo backup a PM_DB_PATH (solo si no existe)
 */
const s3 = config.backup.s3;
if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
  console.error("[backup] faltan BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY");
  process.exit(1);
}
const b = new DbBackup(config.backup, config.pmDbPath);
const cmd = process.argv[2] ?? "backup";
try {
  if (cmd === "restore") {
    const ok = await b.restoreIfMissing(process.argv[3]);
    if (!ok) console.log(`[backup] no se restauro (¿ya existe ${config.pmDbPath}?)`);
  } else {
    await b.run();
  }
} catch (e) {
  console.error(`[backup] fallo: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
