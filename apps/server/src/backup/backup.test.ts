import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { signV4 } from "./s3.js";
import { snapshot } from "./backup.js";

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
