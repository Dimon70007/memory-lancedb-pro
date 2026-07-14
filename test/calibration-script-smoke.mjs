// T048-6 prep: smoke test for scripts/run-calibration.mjs
// Populates recall_log + topic_clusters with synthetic data, runs the script,
// verifies it produces a valid report (Gate D logic works end-to-end).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { LanceDbRecallLogSink } = jiti("../src/recallLogSink.ts");

const workDir = mkdtempSync(path.join(tmpdir(), "t048-calib-"));
const dbPath = path.join(workDir, "db");

const store = new MemoryStore({ dbPath, vectorDim: 4 });

// Seed a memory
const seed = await store.store({
  text: "seed", vector: [1, 0, 0, 0], category: "fact",
  scope: "global", importance: 0.5, metadata: "{}",
});

// Populate recall_log with synthetic data (simulating T048-HOST backfill)
const recallTable = store.getRecallLogTable();
const sink = new LanceDbRecallLogSink(recallTable);
await sink.logBatch([
  {
    query_id: "q1::1::a",
    session_key: "global",
    query_text: "q1",
    candidate_id: seed.id,
    topic_id: "global::hot",
    score_raw: 0.7,
    score_final: 0.74,
    used_in_answer: true,
    user_feedback: 1,
    recall_ts: Date.now(),
    metadata: JSON.stringify({ rank: 1 }),
  },
  {
    query_id: "q2::2::b",
    session_key: "global",
    query_text: "q2",
    candidate_id: "other-id",
    topic_id: "global::cold",
    score_raw: 0.6,
    score_final: 0.6,
    used_in_answer: false,
    user_feedback: null,
    recall_ts: Date.now(),
    metadata: JSON.stringify({ rank: 2 }),
  },
]);

// Populate topic_clusters table
const topicTable = store.getTopicClustersTable();
if (topicTable) {
  await topicTable.add([
    {
      topic_id: "global::hot",
      scope: "global",
      doc_count: 5,
      hit_count: 10,
      last_hit_ts: Date.now(),
      avg_importance: 0.8,
      avg_confidence: 0.7,
      active_weight: 0.9,
      decay_rate: 0.1,
      status: "active",
      metadata: "{}",
    },
  ]);
}

// Flush writes so the script (separate process) can read them
await store.flush();
const out = execFileSync("node", ["scripts/run-calibration.mjs", "--dbPath", dbPath, "--baseline", "0"], {
  cwd: process.cwd(),
  encoding: "utf-8",
});

const report = JSON.parse(out);
assert.ok(report.recall_log_rows >= 2, "recall_log rows read");
assert.ok(report.best_params && typeof report.best_params.theta === "number", "best params returned");
assert.ok(typeof report.gate.pass === "boolean", "gate result is boolean");
assert.ok(report.recommendation.length > 0, "recommendation present");

console.log("✅ T048-6 calibration script smoke test: GREEN");
console.log("   Gate pass:", report.gate.pass, "| avgAnswerGain:", report.gate.avgAnswerGain);
console.log("   Best params:", JSON.stringify(report.best_params));

rmSync(workDir, { recursive: true, force: true });
