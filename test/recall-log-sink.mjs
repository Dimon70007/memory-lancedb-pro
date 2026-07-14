// T048-5 enabler: LanceDbRecallLogSink writes RecallLogEntry rows (incl. null
// topic_id / user_feedback) to the recall_log table and they round-trip.
// TDD: this test is RED until src/recallLogSink.ts + store.getRecallLogTable() exist.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, loadLanceDB } = jiti("../src/store.ts");
const { LanceDbRecallLogSink } = jiti("../src/recallLogSink.ts");

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, e.message]); }
}

await run("store exposes recall_log table via getRecallLogTable()", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "t048-sink-"));
  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    await store.store({
      text: "seed", vector: [1, 0, 0, 0], category: "fact",
      scope: "global", importance: 0.5, metadata: "{}",
    });
    const table = store.getRecallLogTable();
    assert.ok(table, "getRecallLogTable() must return the recall_log table after init");
  } finally { rmSync(workDir, { recursive: true, force: true }); }
});

await run("LanceDbRecallLogSink writes entries with null fields and round-trips", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "t048-sink-"));
  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    await store.store({
      text: "seed", vector: [1, 0, 0, 0], category: "fact",
      scope: "global", importance: 0.5, metadata: "{}",
    });
    const table = store.getRecallLogTable();
    const sink = new LanceDbRecallLogSink(table);

    const entry = {
      query_id: "q1::1::a",
      session_key: "global",
      query_text: "q1",
      candidate_id: "a",
      topic_id: null,            // no parent topic
      score_raw: 0.7,
      score_final: 0.74,
      used_in_answer: false,
      user_feedback: null,       // not yet rated
      recall_ts: 1_700_000_000_000,
      metadata: JSON.stringify({ rank: 1 }),
    };
    await sink.logBatch([entry]);

    const rows = await table.query().toArray();
    assert.equal(rows.length, 1, "sink should have written exactly one row");
    assert.equal(rows[0].candidate_id, "a", "candidate_id preserved");
    assert.equal(rows[0].topic_id, null, "null topic_id preserved");
    assert.equal(rows[0].user_feedback, null, "null user_feedback preserved");
    assert.equal(rows[0].score_final, 0.74, "score_final preserved");
  } finally { rmSync(workDir, { recursive: true, force: true }); }
});

await run("LanceDbRecallLogSink.logBatch([]) is a no-op (no throw)", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "t048-sink-"));
  try {
    const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
    await store.store({
      text: "seed", vector: [1, 0, 0, 0], category: "fact",
      scope: "global", importance: 0.5, metadata: "{}",
    });
    const sink = new LanceDbRecallLogSink(store.getRecallLogTable());
    await sink.logBatch([]); // must not throw
  } finally { rmSync(workDir, { recursive: true, force: true }); }
});

let failed = 0;
for (const [ok, name, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + msg}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} recall_log sink tests passed`);
process.exit(failed ? 1 : 0);
