// T048 regression: recall_log table must be CREATED with a valid (nullable-aware)
// schema during store init. Guards against the LanceDB "Failed to infer data type
// for field topic_id" bug caused by a null first sample row (fixed 2026-07-08).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, loadLanceDB } = jiti("../src/store.ts");

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, e.message]); }
}

await run("recall_log table is created and openable after store init", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "t048-recall-log-"));
  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    // Trigger doInitialize (creates topic_clusters + recall_log tables).
    await store.store({
      text: "seed memory",
      vector: [0, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
    });

    // Open the DB directly and confirm recall_log exists & is readable.
    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(path.join(workDir, "db"));
    const table = await db.openTable("recall_log");
    assert.ok(table, "recall_log table should open without schema-inference error");
    const rows = await table.query().toArray();
    assert.ok(Array.isArray(rows), "recall_log should be queryable");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

await run("recall_log schema accepts nullable topic_id / user_feedback", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "t048-recall-log-null-"));
  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    await store.store({
      text: "seed",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: JSON.stringify({ parent_topic_id: "global::demo" }),
    });

    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(path.join(workDir, "db"));
    const table = await db.openTable("recall_log");
    // Insert a real row with nullable fields set to null — must NOT throw.
    await table.add([{
      query_id: "q1::1::a",
      session_key: "global",
      query_text: "q1",
      candidate_id: "a",
      topic_id: null,
      score_raw: 0.7,
      score_final: 0.74,
      used_in_answer: false,
      user_feedback: null,
      recall_ts: 1_700_000_000_000,
      metadata: "{}",
    }]);
    const rows = await table.query().toArray();
    assert.equal(rows.length, 1, "nullable insert should succeed");
    assert.equal(rows[0].topic_id, null, "topic_id null preserved");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const [ok, name, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + msg}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} recall_log table-creation regression tests passed`);
process.exit(failed ? 1 : 0);
