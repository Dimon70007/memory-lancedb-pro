// T048-6 dry-run: generate a realistic synthetic recall_log + topic_clusters
// dataset so calibration can be exercised end-to-end without prod data.
// Scenario: 10 topics, 5 "useful" (high importance, often used, +feedback)
// and 5 "noisy" (low importance, rarely used, -feedback). Boosting useful
// topics should improve mean used-rank gain.

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { LanceDbRecallLogSink } = jiti("../src/recallLogSink.ts");

const workDir = mkdtempSync(path.join(tmpdir(), "t048-synth-"));
const dbPath = path.join(workDir, "db");

const store = new MemoryStore({ dbPath, vectorDim: 4 });
await store.ensureInitialized();
await store.store({ text: "seed", vector: [1, 0, 0, 0], category: "fact", scope: "global", importance: 0.5, metadata: "{}" });

const recallTable = store.getRecallLogTable();
const topicTable = store.getTopicClustersTable();
const sink = new LanceDbRecallLogSink(recallTable);

const topics = [];
for (let i = 0; i < 10; i++) {
  const useful = i < 5;
  topics.push({
    topic_id: `topic-${i}`,
    scope: "global",
    doc_count: 20 + i * 5,
    hit_count: useful ? 40 + i * 10 : 5 + i,
    last_hit_ts: Date.now() - (useful ? 1000 * 60 * 60 * i : 1000 * 60 * 60 * 24 * 30),
    avg_importance: useful ? 0.7 + i * 0.02 : 0.1 + i * 0.01,
    avg_confidence: useful ? 0.8 : 0.3,
    active_weight: useful ? 0.7 : 0.2,
    decay_rate: 0.05,
    status: "active",
    metadata: JSON.stringify({ useful }),
  });
}
await topicTable.add(topicTable.createWriteInput ? topicTable.createWriteInput(topics) : topics);

// Generate ~200 recall events
const logEntries = [];
let ts = Date.now() - 1000 * 60 * 60 * 24 * 7;
for (let q = 0; q < 40; q++) {
  const topic = topics[q % 10];
  const useful = JSON.parse(topic.metadata).useful;
  const nCand = 5;
  for (let r = 0; r < nCand; r++) {
    const isTop = r < 2;
    // Useful topics: top candidates get used + positive feedback
    const used = useful && isTop && Math.random() < 0.8;
    const feedback = used ? 1 : useful ? (Math.random() < 0.3 ? 1 : 0) : (Math.random() < 0.4 ? -1 : 0);
    const scoreRaw = 0.5 + (isTop ? 0.3 : 0.1) - r * 0.05 + Math.random() * 0.05;
    // Final score already has a small boost for useful topics (simulating current behavior)
    const scoreFinal = scoreRaw + (useful ? 0.05 : 0);
    const cid = `cand-${q}-${r}`;
    logEntries.push({
      query_id: `q${q}::${ts}::${cid}`,
      session_key: "global",
      query_text: `query about topic ${q % 10}`,
      candidate_id: cid,
      topic_id: topic.topic_id,
      score_raw: scoreRaw,
      score_final: scoreFinal,
      used_in_answer: used,
      user_feedback: feedback,
      recall_ts: ts,
      metadata: JSON.stringify({ rank: r + 1, useful }),
    });
  }
  ts += 1000 * 60 * 60; // 1h apart
}
await sink.logBatch(logEntries);

console.log(`Generated ${logEntries.length} recall_log rows across ${topics.length} topics.`);
console.log(`DB at: ${dbPath}`);
console.log(dbPath); // last line = dbPath for caller
