// T048-5: end-to-end host wiring test.
// Simulates the full host wiring flow:
//   1. LanceDbRecallLogSink writes to recall_log table
//   2. Retriever fires logBatch on retrieve
//   3. Host post-hoc updates used_in_answer + user_feedback
//   4. verify: log rows exist with correct fields + avg_answer_gain > 0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { LanceDbRecallLogSink } = jiti("../src/recallLogSink.ts");
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { computeAvgAnswerGain } = jiti("../src/calibration.ts");

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String(e)]); }
}

const workDir = mkdtempSync(path.join(tmpdir(), "t048-wiring-"));

await run("E2E: sink + retriever hook + post-hoc update + avg_gain", async () => {
  const store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });

  // Seed one memory so retriever has something
  const seed = await store.store({
    text: "seed memory", vector: [1, 0, 0, 0], category: "fact",
    scope: "global", importance: 0.5, metadata: "{}",
  });
  const actualId = seed.id; // real UUID from store()

  const table = store.getRecallLogTable();
  assert.ok(table, "recall_log table available");

  // Wire sink → retriever
  const sink = new LanceDbRecallLogSink(table);
  const embedder = { async embedQuery() { return [1, 0, 0, 0]; } };

  const retriever = createRetriever(
    store,
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0 },
    { topicClusterProvider: { async getActiveWeight() { return 0.9; } }, recallLogSink: sink }
  );

  // Retrieve → fires logBatch (used_in_answer=false, user_feedback=null)
  const retrieveResults = await retriever.retrieve({ query: "test", limit: 5, scopeFilter: ["global"] });
  assert.ok(retrieveResults.length > 0, "retrieval returned results");

  // Wait for fire-and-forget logBatch
  await new Promise((r) => setTimeout(r, 100));

  // Verify rows written
  const rows = await table.query().toArray();
  assert.ok(rows.length > 0, `recall_log has ${rows.length} rows`);

  const row = rows[0];
  assert.equal(row.used_in_answer, false, "default used_in_answer = false");
  assert.equal(row.user_feedback, null, "default user_feedback = null");
  assert.equal(row.candidate_id, actualId, "candidate_id matches seed entry");

  // Post-hoc: mark used_in_answer = true for the candidate
  await table.update({ where: `candidate_id = '${actualId}'`, values: { used_in_answer: true } });

  const updatedRows = await table.query().toArray();
  const updated = updatedRows.find((r) => r.candidate_id === actualId);
  assert.ok(updated, "updated row found");
  assert.equal(updated.used_in_answer, true, "post-hoc used_in_answer = true");

  // Post-hoc: set user_feedback
  await table.update({ where: `candidate_id = '${actualId}'`, values: { user_feedback: 1 } });

  const finalRows = await table.query().toArray();
  const finalA = finalRows.find((r) => r.candidate_id === actualId);
  assert.equal(finalA.user_feedback, 1, "post-hoc user_feedback = 1");

  // Verify avg_answer_gain > 0 (learning signal works)
  const avgGain = computeAvgAnswerGain(finalRows);
  assert.ok(avgGain > 0, `avg_answer_gain > 0: ${avgGain}`);
});

// Print results
let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}: ${msg}`); }
}
console.log(`\n${pass}/${pass + fail} T048-5 host wiring tests passed`);

rmSync(workDir, { recursive: true, force: true });

if (fail > 0) process.exit(1);
