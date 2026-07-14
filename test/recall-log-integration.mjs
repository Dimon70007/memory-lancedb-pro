// T048-4c (TDD, RED): recall_log recording on retrieve.
// Feature (recallLogSink wiring) not implemented yet → captured stays empty → RED.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

const captured = [];
const fakeSink = {
  async logBatch(entries) {
    captured.push(...entries);
  },
};

const entryA = {
  id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global",
  importance: 0.5, timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::hot" }),
};
const entryB = {
  id: "b", text: "b", vector: [0, 1], category: "fact", scope: "global",
  importance: 0.5, timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::cold" }),
};
const store = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry: entryA, score: 0.7 }, { entry: entryB, score: 0.72 }];
  },
  async bm25Search() { return []; },
  async hasId(id) { return id === "a" || id === "b"; },
};
const embedder = { async embedQuery() { return [1, 0]; } };

// FLAG ON → entryA (hot, aw=0.9) boosted, entryB (cold, aw=0) not boosted.
const retriever = createRetriever(
  store,
  embedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0,
    clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08 },
  },
  {
    topicClusterProvider: { async getActiveWeight(id) { return id === "global::hot" ? 0.9 : 0; } },
    recallLogSink: fakeSink,
  },
);

const results = await retriever.retrieve({ query: "content", limit: 5, scopeFilter: ["global"] });
assert.equal(results.length, 2, "both entries returned");

// §9.3: one recall_log row per returned candidate.
assert.equal(captured.length, 2, "recall_log should receive one row per returned candidate");

// §4 schema fields present + sane defaults.
for (const e of captured) {
  assert.ok(typeof e.candidate_id === "string" && e.candidate_id.length > 0, "candidate_id present");
  assert.ok(typeof e.topic_id === "string", "topic_id present");
  assert.ok(typeof e.score_raw === "number" && Number.isFinite(e.score_raw), "score_raw finite");
  assert.ok(typeof e.score_final === "number" && Number.isFinite(e.score_final), "score_final finite");
  assert.equal(e.used_in_answer, false, "used_in_answer defaults false (filled post-hoc)");
  assert.equal(e.user_feedback, null, "user_feedback defaults null");
  assert.ok(typeof e.recall_ts === "number", "recall_ts present");
  assert.ok(typeof e.query_text === "string" && e.query_text.length > 0, "query_text present");
  assert.ok(typeof e.session_key === "string", "session_key present");
}

// score_raw (pre-boost) vs score_final (post-boost).
const aLog = captured.find((e) => e.candidate_id === "a");
const bLog = captured.find((e) => e.candidate_id === "b");
assert.ok(aLog.score_final > aLog.score_raw, "boosted entry: final > raw");
assert.ok(
  Math.abs(bLog.score_final - bLog.score_raw) < 1e-12,
  "non-boosted entry (aw=0): final == raw",
);

// FLAG OFF → no boost → score_raw == score_final for all.
const capturedOff = [];
const offRetriever = createRetriever(
  store,
  embedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0,
    clusterBoostEnabled: false,
  },
  {
    topicClusterProvider: { async getActiveWeight() { return 0.9; } },
    recallLogSink: { async logBatch(entries) { capturedOff.push(...entries); } },
  },
);
await offRetriever.retrieve({ query: "content", limit: 5, scopeFilter: ["global"] });
for (const e of capturedOff) {
  assert.ok(
    Math.abs(e.score_final - e.score_raw) < 1e-12,
    `FLAG OFF: ${e.candidate_id} final == raw`,
  );
}

console.log("OK: recall-log integration tests passed");
