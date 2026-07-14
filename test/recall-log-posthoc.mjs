// T048-HOST: post-hoc backfill methods on MemoryStore.
// Verifies markUsedInAnswer, recordFeedback, and per-session candidate tracking.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { LanceDbRecallLogSink } = jiti("../src/recallLogSink.ts");

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String(e)]); }
}

const workDir = mkdtempSync(path.join(tmpdir(), "t048-posthoc-"));

await run("markUsedInAnswer updates recall_log rows", async () => {
  const store = new MemoryStore({ dbPath: path.join(workDir, "db1"), vectorDim: 4 });
  await store.store({ text: "seed", vector: [1, 0, 0, 0], category: "fact", scope: "global", importance: 0.5, metadata: "{}" });
  const table = store.getRecallLogTable();
  const sink = new LanceDbRecallLogSink(table);
  const cid = "cand-123";
  await sink.logBatch([{
    query_id: "q1::1::" + cid,
    session_key: "global",
    query_text: "q1",
    candidate_id: cid,
    topic_id: null,
    score_raw: 0.7, score_final: 0.74,
    used_in_answer: false, user_feedback: null,
    recall_ts: Date.now(), metadata: JSON.stringify({ rank: 1 }),
  }]);

  await store.markUsedInAnswer([cid]);
  const rows = await table.query().toArray();
  const row = rows.find((r) => r.candidate_id === cid);
  assert.equal(row.used_in_answer, true, "used_in_answer should be true after markUsedInAnswer");
});

await run("recordFeedback updates user_feedback", async () => {
  const store = new MemoryStore({ dbPath: path.join(workDir, "db2"), vectorDim: 4 });
  await store.store({ text: "seed", vector: [1, 0, 0, 0], category: "fact", scope: "global", importance: 0.5, metadata: "{}" });
  const table = store.getRecallLogTable();
  const sink = new LanceDbRecallLogSink(table);
  const cid = "cand-456";
  await sink.logBatch([{
    query_id: "q2::1::" + cid,
    session_key: "global",
    query_text: "q2",
    candidate_id: cid,
    topic_id: null,
    score_raw: 0.6, score_final: 0.6,
    used_in_answer: false, user_feedback: null,
    recall_ts: Date.now(), metadata: JSON.stringify({ rank: 1 }),
  }]);

  await store.recordFeedback(cid, 1);
  const rows = await table.query().toArray();
  const row = rows.find((r) => r.candidate_id === cid);
  assert.equal(row.user_feedback, 1, "user_feedback should be 1 after recordFeedback");
});

await run("per-session candidate tracking", async () => {
  const store = new MemoryStore({ dbPath: path.join(workDir, "db3"), vectorDim: 4 });
  store.trackCandidate("sess-A", "c1", "hello world this is a memory");
  store.trackCandidate("sess-A", "c2", "another memory text");
  store.trackCandidate("sess-B", "c3", "different session");

  const a = store.getTrackedCandidates("sess-A");
  assert.equal(a.size, 2, "sess-A should have 2 candidates");
  assert.equal(a.get("c1"), "hello world this is a memory");

  const b = store.getTrackedCandidates("sess-B");
  assert.equal(b.size, 1, "sess-B should have 1 candidate");

  store.clearTrackedCandidates("sess-A");
  assert.equal(store.getTrackedCandidates("sess-A").size, 0, "sess-A cleared");
});

await run("markUsedInAnswer is non-fatal on empty input", async () => {
  const store = new MemoryStore({ dbPath: path.join(workDir, "db4"), vectorDim: 4 });
  // Should not throw
  await store.markUsedInAnswer([]);
  await store.recordFeedback("", 1);
  assert.ok(true, "empty input handled gracefully");
});

let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}: ${msg}`); }
}
console.log(`\n${pass}/${pass + fail} T048-HOST post-hoc tests passed`);

rmSync(workDir, { recursive: true, force: true });
if (fail > 0) process.exit(1);
