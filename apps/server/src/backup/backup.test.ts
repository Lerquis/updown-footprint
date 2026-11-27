import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { signV4 } from "./s3.js";
import { backupsToPrune, shouldMoveLatest, snapshot } from "./backup.js";

test("signV4 reproduce el ejemplo oficial de AWS (GET Object con Range)", () => {
  const h = signV4({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    amzDate: "20130524T000000Z",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("snapshot copia una base WAL mientras sigue abierta para escribir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  try {
    const src = join(dir, "a.db");
    const db = new DatabaseSync(src);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER)");
    const ins = db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 1000; i++) ins.run(i);
    await snapshot(src, join(dir, "b.db"));
    ins.run(1000); // la base original sigue usable
    const copy = new DatabaseSync(join(dir, "b.db"));
    assert.deepEqual({ ...copy.prepare("SELECT count(*) n FROM t").get() }, { n: 1000 });
    copy.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const H = 3600_000;
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const item = (hoursAgo: number, name = `updown/v2/polymarket-${hoursAgo}h.db.gz`) => ({ key: name, lastModified: NOW - hoursAgo * H });

test("backupsToPrune: conserva todo lo de las ultimas keepHours h", () => {
  const items = [1, 2, 10, 30, 47].map((h) => item(h));
  assert.deepEqual(backupsToPrune(items, NOW, 48), []);
});

test("backupsToPrune: de lo anterior deja la primera copia de cada dia UTC", () => {
  // 25 nov: 3 copias (60, 59, 58 h antes de NOW = 25 nov 00:00-02:00); 24 nov: 2 copias (80, 79 h)
  const items = [item(80), item(79), item(60), item(59), item(58), item(1)];
  const pruned = backupsToPrune(items, NOW, 48).sort();
  assert.deepEqual(pruned, [item(79).key, item(58).key, item(59).key].sort());
});

test("backupsToPrune: nunca borra la mas reciente ni lo que no es una copia", () => {
  const items = [item(100), item(99), { key: "updown/v2/latest.json", lastModified: NOW - 100 * H }, { key: "updown/archive/polymarket-local.db.gz", lastModified: NOW - 200 * H }];
  // archive esta fuera del prefijo en la practica, pero aun asi solo se mira el patron de copia: la mas reciente (99 h) se conserva
  const pruned = backupsToPrune(items, NOW, 48);
  assert.ok(!pruned.includes("updown/v2/latest.json"));
  assert.ok(!pruned.includes(item(99).key));
});

test("shouldMoveLatest: una base vaciada no pisa el puntero de restauracion", () => {
  assert.equal(shouldMoveLatest(undefined, 0), true); // primera copia
  assert.equal(shouldMoveLatest(null, 5), true);
  assert.equal(shouldMoveLatest(260, 261), true);
  assert.equal(shouldMoveLatest(260, 260), true);
  assert.equal(shouldMoveLatest(260, 0), false); // el caso del 27 nov: volumen perdido
});
