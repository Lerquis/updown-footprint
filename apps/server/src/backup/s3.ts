import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";

/**
 * Cliente S3 minimo (firma AWS SigV4) para guardar backups en Cloudflare R2, Backblaze B2, AWS S3, etc.
 * Sin dependencias: solo PUT/GET de objetos y subida multiparte (archivos grandes, por partes).
 */
export interface S3Config {
  /** p. ej. https://<account_id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "auto" en R2 */
  region: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
/** Codificacion URI de SigV4: todo salvo A-Z a-z 0-9 - _ . ~ */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  host: string;
  /** ruta ya sin codificar, empieza por "/" */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** hash hex del cuerpo */
  payloadHash: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Firma SigV4 (servicio s3). Devuelve las cabeceras a enviar (incluye Authorization). Pura, con prueba. */
export function signV4(i: SignInput): Record<string, string> {
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": i.amzDate };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.entries(i.query ?? {})
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalPath = i.path.split("/").map(enc).join("/");
  const canonicalRequest = [i.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${date}/${i.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

const amzNow = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Partes de 64 MB: R2/S3 permiten hasta 10.000 partes (≈ 640 GB) */
const PART_SIZE = 64 * 1024 * 1024;

export interface S3Object {
  key: string;
  size: number;
  /** ms */
  lastModified: number;
}

export class S3Lite {
  private readonly url: URL;
  constructor(private readonly cfg: S3Config) {
    this.url = new URL(cfg.endpoint);
  }

  /** Peticion firmada; `body` es un Buffer o un rango de un archivo. */
  private send(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: Buffer | { file: string; start: number; end: number }; payloadHash?: string; headers?: Record<string, string> } = {},
  ): Promise<IncomingMessage> {
    const path = key ? `/${this.cfg.bucket}/${key}` : `/${this.cfg.bucket}`;
    const len = opts.body === undefined ? 0 : Buffer.isBuffer(opts.body) ? opts.body.length : opts.body.end - opts.body.start + 1;
    const payloadHash = opts.payloadHash ?? sha256(Buffer.isBuffer(opts.body) ? opts.body : Buffer.alloc(0));
    const headers = signV4({
      method,
      host: this.url.host,
      path,
      query: opts.query,
      headers: { ...opts.headers, ...(opts.body !== undefined ? { "content-length": String(len) } : {}) },
      payloadHash,
      amzDate: amzNow(),
      region: this.cfg.region,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
    });
    const qs = Object.entries(opts.query ?? {})
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join("&");
    const fullPath = path.split("/").map(enc).join("/") + (qs ? `?${qs}` : "");
    return new Promise((resolve, reject) => {
      const req = request({ method, host: this.url.hostname, port: this.url.port || 443, path: fullPath, headers }, resolve);
      req.on("error", reject);
      req.setTimeout(10 * 60_000, () => req.destroy(new Error("timeout")));
      if (opts.body === undefined) req.end();
      else if (Buffer.isBuffer(opts.body)) req.end(opts.body);
      else createReadStream(opts.body.file, { start: opts.body.start, end: opts.body.end }).on("error", reject).pipe(req);
    });
  }

  private async ok(res: IncomingMessage, what: string): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if ((res.statusCode ?? 0) >= 300) throw new Error(`${what}: HTTP ${res.statusCode} ${text.slice(0, 300)}`);
    return text;
  }

  /** Lista los objetos bajo un prefijo (ListObjectsV2, paginado). */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const xml = await this.ok(await this.send("GET", "", { query }), `LIST ${prefix}`);
      for (const c of xml.split("<Contents>").slice(1)) {
        const key = /<Key>([^<]+)<\/Key>/.exec(c)?.[1];
        if (!key) continue;
        out.push({
          key: key.replace(/&amp;/g, "&"),
          size: Number(/<Size>(\d+)<\/Size>/.exec(c)?.[1] ?? 0),
          lastModified: Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(c)?.[1] ?? "") || 0,
        });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.ok(await this.send("DELETE", key), `DELETE ${key}`);
  }

  async putBuffer(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    await this.ok(await this.send("PUT", key, { body, headers: { "content-type": contentType } }), `PUT ${key}`);
  }

  /** Descarga un objeto de texto pequeno; null si no existe. */
  async getText(key: string): Promise<string | null> {
    const res = await this.send("GET", key);
    if (res.statusCode === 404) {
      res.resume();
      return null;
    }
    return this.ok(res, `GET ${key}`);
  }

  /** Descarga un objeto a un archivo (en streaming). */
  async getToFile(key: string, file: string): Promise<void> {
    const res = await this.send("GET", key);
    if ((res.statusCode ?? 0) >= 300) await this.ok(res, `GET ${key}`);
    await pipeline(res, createWriteStream(file));
  }

  /** Sube un archivo (de cualquier tamano) con subida multiparte; cada parte va firmada con su hash. */
  async putFile(key: string, file: string): Promise<void> {
    const size = (await stat(file)).size;
    const created = await this.ok(await this.send("POST", key, { query: { uploads: "" }, body: Buffer.alloc(0) }), `CreateMultipartUpload ${key}`);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)?.[1];
    if (!uploadId) throw new Error(`CreateMultipartUpload ${key}: sin UploadId`);
    try {
      const etags: string[] = [];
      for (let start = 0, n = 1; start < Math.max(size, 1); start += PART_SIZE, n++) {
        const end = Math.min(size, start + PART_SIZE) - 1;
        const hash = createHash("sha256");
        if (end >= start) for await (const c of createReadStream(file, { start, end })) hash.update(c as Buffer);
        const body = end >= start ? { file, start, end } : Buffer.alloc(0);
        const res = await this.send("PUT", key, { query: { partNumber: String(n), uploadId }, body, payloadHash: hash.digest("hex") });
        await this.ok(res, `UploadPart ${n}`);
        const etag = res.headers.etag;
        if (!etag) throw new Error(`UploadPart ${n}: sin ETag`);
        etags.push(etag);
      }
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      await this.ok(await this.send("POST", key, { query: { uploadId }, body: Buffer.from(xml), headers: { "content-type": "application/xml" } }), `CompleteMultipartUpload ${key}`);
    } catch (e) {
      // no dejar partes huerfanas ocupando espacio
      await this.send("DELETE", key, { query: { uploadId } }).then((r) => r.resume(), () => undefined);
      throw e;
    }
  }
}
