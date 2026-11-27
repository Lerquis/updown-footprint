# Despliegue del servidor en Railway (con backups a R2)

El servidor es quien recoge los datos 24 h (Binance, Polymarket), así que es él quien va a la nube, no solo la base. Decisión: [ADR 0009](../decisions/0009-railway-volumen-y-backups-r2.md).

```
Railway (región Amsterdam)                       Cloudflare R2
┌─────────────────────────────────┐   backup     ┌──────────────────────────┐
│ servicio "server" (Docker)      │ ───────────▶ │ updown/v2/polymarket-<fecha> │
│  node --import tsx src/index.ts │ cada 1 h y   │ updown/v2/latest.json        │
│  Volume /data/polymarket.db     │ ◀─────────── │                           │
└─────────────────────────────────┘  restaurar   └──────────────────────────┘
          ▲ wss:// + https:// (/ws/*, /api/markets)    (si el volumen está vacío)
          │
     frontend (apps/web)
```

- **Base**: la misma SQLite de siempre, en un **Volume** de Railway montado en `/data` (`PM_DB_PATH=/data/polymarket.db`, ya fijado en el Dockerfile; el archivo real lleva la generación: `/data/polymarket-v2.db`). Sin cambios de código respecto a local.
- **Backup**: cada `BACKUP_INTERVAL_H` (1 h) **y al apagar** (SIGTERM antes de cada deploy) el servidor hace una copia consistente (`VACUUM INTO` en un hilo aparte, no bloquea), la comprime y la sube al bucket. `latest.json` apunta a la última, pero **nunca retrocede**: una copia con menos markets (base vaciada) no lo mueve. Retención: todo lo de 48 h + una por día. Ver [ADR 0013](../decisions/0013-backups-horarios-y-al-apagar.md).
- **Comprobar**: `GET /health` → `db.onVolume` debe ser `true` en Railway, `db.backup.last` reciente y `polymarket.saved` creciendo. **Antes de cada deploy**, mirar que `saved` > 0 y `db.backup.last` tenga menos de 1 h.
- **Restauración**: con `PM_DB_RESTORE=true`, si al arrancar **no existe** la base, se descarga la última copia antes de abrirla. Nunca sobrescribe una base existente.
- Todo lo de backup se desactiva solo si faltan las variables `BACKUP_S3_*`: en local nada cambia.

## Monorepo
No es problema. El servicio de Railway usa la **raíz del repo** como contexto de build (necesita `package-lock.json` y `packages/protocol`), y la configuración vive en `apps/server/`:
- `apps/server/Dockerfile` — instala solo el workspace `@updown/server` (+ `@updown/protocol`); el frontend no se instala ni se construye.
- `apps/server/railway.json` — builder Docker, healthcheck `/health`, 1 réplica, reinicio siempre, y `watchPatterns` para que solo redespliegue si cambian `apps/server/**`, `packages/protocol/**` o el lockfile.
- `.dockerignore` (raíz) — deja fuera `node_modules`, `.env*`, `apps/server/data`, `.git`.

## 1. Bucket de backups (Cloudflare R2)
1. Cloudflare → R2 → crear bucket (p. ej. `updown-backups`), ubicación Europa.
2. R2 → *Manage API tokens* → token con permiso **Object Read & Write** limitado a ese bucket. Anotar *Access Key ID*, *Secret Access Key* y el endpoint `https://<account_id>.r2.cloudflarestorage.com`.
3. (Opcional) Regla de ciclo de vida del bucket: borrar objetos con prefijo `updown/v2/polymarket-` de más de 30 días (no tocar `updown/archive/`), para no acumular una copia completa por día.

Sirve cualquier almacenamiento compatible con S3 (Backblaze B2, AWS S3): solo cambian endpoint y región.

## 2. Subir la base actual (una vez)
Para no empezar de cero, se sube la base local al bucket y Railway la descarga al primer arranque.
1. Añadir en `apps/server/.env.local` (gitignored) las variables `BACKUP_S3_*` (tabla abajo).
2. `npm run backup -w @updown/server` → sube una copia de `data/polymarket-v2.db` (se puede hacer con el servidor local en marcha).

## 3. Servicio en Railway
1. *New project* → *Deploy from GitHub repo* → este repo.
2. Ajustes del servicio:
   - **Root directory**: vacío (raíz del repo).
   - **Config as code** (*Railway config file*): `/apps/server/railway.json`.
   - **Region**: Europe West (Amsterdam). El volumen debe estar en la misma región.
3. Click derecho en el servicio → *Attach volume* → mount path **`/data`**. Tamaño: la base crece ~190 MB/día sin comprimir (~5,5 GB/mes); ampliar el volumen cuando haga falta.
4. Variables (*Variables* del servicio; los secretos solo aquí, nunca en el repo):

| Variable | Valor |
|---|---|
| `PM_CLOB_API_KEY`, `PM_CLOB_SECRET`, `PM_CLOB_PASSPHRASE` | Las de `.env.local` (TWAP de Chainlink y latencia) |
| `PM_WALLET_PRIVATE_KEY`, `TRADING_PASSWORD` | Compras reales del motor C ([live-trading](../features/live-trading.md)): clave privada de la EOA firmante y contraseña del interruptor. Sin ellas, desactivado |
| `PM_SIGNER_ADDRESS`, `PM_FUNDER_ADDRESS` | Las de `.env.local`: signer y proxy wallet para la medida de latencia ([latency](../features/latency.md)). Sin ellas la orden de prueba responde 401 |
| `ALLOWED_ORIGIN` | URL del frontend, p. ej. `https://updown.vercel.app` (vacío = cualquier origen) |
| `BACKUP_S3_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | `updown-backups` |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | Token de R2 |
| `PM_DB_RESTORE` | `true` (descarga la última copia si el volumen está vacío). En Railway ya es el valor por defecto |
| `PM_DB_PATH` | **No definirla.** El Dockerfile ya usa `/data/polymarket.db`. Una ruta relativa (`data/...`) dejaba la base fuera del volumen ([ADR 0013](../decisions/0013-backups-horarios-y-al-apagar.md)); ahora el servidor la corrige sola, pero mejor no definirla |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | **No definirla** (o `180`): `railway.json` ya fija `drainingSeconds: 180` para que dé tiempo al backup final. Con `10` el backup al apagar se corta |

`PORT` lo pone Railway; el resto de variables tienen los mismos valores por defecto que en local ([development.md](development.md)).

5. *Settings → Networking → Generate domain*. Comprobar `https://<dominio>/health` (`ready: true`, `chainlink: connected`) y que el log diga `base restaurada desde …` y `N markets completos guardados`.

## 4. Pasar a la nube sin perder markets
1. Paso 2 (backup local) → paso 3 (deploy). Mientras ambos corren, cada uno guarda en su propia base.
2. Cuando el de Railway esté `ready`, parar el servidor local (o dejarlo solo para desarrollo). Los markets que el local guardó entre el backup y el deploy no están en la nube; si importan, repetir el paso 2 y re-desplegar con el volumen vacío **antes** de que Railway guarde nada propio.
3. Frontend: `NEXT_PUBLIC_WS_URL=wss://<dominio>` (la API se deriva: `https://<dominio>/api/markets`).

## Operación
- **Cada deploy reinicia el servidor** (con volumen solo hay 1 réplica): se pierde el market en curso y hay un hueco breve de aggTrades. Desplegar justo al empezar un market.
- **Backup manual**: igual que el paso 2, o reducir `BACKUP_INTERVAL_H`. Cada backup ocupa en disco temporal (`/data/backup-tmp`) una copia sin comprimir + la comprimida: el volumen necesita ~2× el tamaño de la base libre.
- **Restaurar en local** desde la nube: `npm run backup -w @updown/server -- restore` (solo si `data/polymarket-v2.db` no existe; con una clave concreta: `-- restore updown/v2/polymarket-<fecha>.db.gz`).
- **Archivo de la generación anterior**: al arrancar, si existe la base sin sufijo (`polymarket.db`) y no tiene marca `.archived`, se sube **una vez** a `updown/archive/polymarket-<railway|local>-<fecha>.db.gz` (también a mano: `npm run backup -w @updown/server -- archive`). No se borra ni se modifica ([ADR 0011](../decisions/0011-tres-motores-guardados-y-base-v2.md)).
- **Desastre** (volumen borrado): crear volumen nuevo en `/data` con `PM_DB_RESTORE=true` → arranca desde la última copia.

## Variables de backup
| Variable | Defecto | Qué hace |
|---|---|---|
| `BACKUP_S3_ENDPOINT` / `BACKUP_S3_BUCKET` / `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | vacío | Bucket S3/R2. Si falta alguna, no hay backups ni restauración |
| `BACKUP_S3_REGION` | `auto` | `auto` en R2; región real en S3/B2 |
| `BACKUP_PREFIX` | `updown/` | Carpeta base: los backups van a `<prefijo>v2/` (generación de la base) y el archivo de bases anteriores a `<prefijo>archive/` |
| `BACKUP_INTERVAL_H` | `1` | Horas entre backups (se recuerda en `/data/<base>.last-backup`); además hay backup al apagar |
| `BACKUP_KEEP_H` | `48` | Horas en que se conservan todas las copias; las anteriores se reducen a una por día |
| `BACKUP_SHUTDOWN_TIMEOUT_S` | `150` | Máximo del backup final al apagar (menor que `drainingSeconds` 180) |
| `BACKUP_ENABLED` | `true` | `false`: no programar backups (la restauración y `npm run backup` siguen funcionando) |
| `PM_DB_RESTORE` | `false` | Al arrancar sin base, descargar la última copia |
