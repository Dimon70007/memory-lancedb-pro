#!/usr/bin/env node
// T048-6: Phase 3 calibration run script.
// Reads real recall_log + topic_clusters tables, runs tuneParameters (grid search),
// evaluates Gate D, and reports whether clusterBoostEnabled can be flipped ON.
//
// Usage:
//   node scripts/run-calibration.mjs --dbPath /path/to/lancedb --baseline 0
//
// Prerequisites:
//   - T048-HOST must have populated recall_log with used_in_answer + user_feedback
//   - topic_clusters table must have rows (from T048-4b)
//
// Output: JSON with best params, gate result, and a recommendation.

import { parseArgs } from "node:util";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const {
  tuneParameters,
  evaluateGate,
  DEFAULT_CALIBRATION,
  RecallLogRow,
  TopicClusterRow,
} = jiti("../src/calibration.ts");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dbPath: { type: "string", default: undefined },
    baseline: { type: "string", default: "0" },
    criticalIds: { type: "string", default: "" }, // comma-separated candidate_ids
    thetaGrid: { type: "string", default: undefined },
    aGrid: { type: "string", default: undefined },
    bGrid: { type: "string", default: undefined },
    cGrid: { type: "string", default: undefined },
    dGrid: { type: "string", default: undefined },
  },
});

if (!values.dbPath) {
  console.error("ERROR: --dbPath is required (path to the LanceDB store directory)");
  process.exit(2);
}

const store = new MemoryStore({ dbPath: values.dbPath, vectorDim: 4 });
await store.ensureInitialized();

// Read recall_log table
const recallTable = store.getRecallLogTable();
if (!recallTable) {
  console.error("ERROR: recall_log table not found. Run T048-HOST first to populate it.");
  process.exit(3);
}
const recallRows = await recallTable.query().toArray();
if (recallRows.length === 0) {
  console.error("ERROR: recall_log is empty. T048-HOST must backfill used_in_answer + user_feedback.");
  process.exit(4);
}

// Read topic_clusters table
const topicTable = store.getTopicClustersTable();
const topics = new Map();
if (topicTable) {
  const topicRows = await topicTable.query().toArray();
  for (const row of topicRows) {
    topics.set(row.topic_id, {
      topic_id: row.topic_id,
      scope: row.scope,
      doc_count: Number(row.doc_count) || 0,
      hit_count: Number(row.hit_count) || 0,
      last_hit_ts: Number(row.last_hit_ts) || 0,
      avg_importance: Number(row.avg_importance) || 0,
      avg_confidence: Number(row.avg_confidence) || 0,
      active_weight: Number(row.active_weight) || 0,
      decay_rate: Number(row.decay_rate) || 0,
      status: row.status || "active",
      metadata: row.metadata || "{}",
    });
  }
}

// Critical IDs (never-regress set)
const criticalIds = new Set(
  values.criticalIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Optional grid overrides
const gridOverrides = {};
if (values.thetaGrid) gridOverrides.thetaGrid = values.thetaGrid.split(",").map(Number);
if (values.aGrid) gridOverrides.aGrid = values.aGrid.split(",").map(Number);
if (values.bGrid) gridOverrides.bGrid = values.bGrid.split(",").map(Number);
if (values.cGrid) gridOverrides.cGrid = values.cGrid.split(",").map(Number);
if (values.dGrid) gridOverrides.dGrid = values.dGrid.split(",").map(Number);

// Tune parameters
const best = tuneParameters({
  rows: recallRows,
  topics,
  baseline: Number(values.baseline) || 0,
  criticalIds,
  now: Date.now(),
  ...gridOverrides,
});

// Evaluate Gate D
const gate = evaluateGate({
  rows: recallRows,
  baseline: Number(values.baseline) || 0,
  criticalIds,
  params: best,
});

// Report
const report = {
  recall_log_rows: recallRows.length,
  topic_clusters_rows: topics.size,
  critical_ids: [...criticalIds],
  best_params: best,
  gate: {
    pass: gate.pass,
    avgAnswerGain: gate.avgAnswerGain,
    baseline: Number(values.baseline) || 0,
    regression: gate.regression,
  },
  recommendation: gate.pass
    ? "ENABLE clusterBoostEnabled (flip default ON in openclaw.json / plugin config)"
    : "KEEP clusterBoostEnabled OFF (Gate D not passed; collect more recall_log data)",
};

console.log(JSON.stringify(report, null, 2));

// Exit code: 0 if gate passes, 1 if not
process.exit(gate.pass ? 0 : 1);
