// T048-4a (TDD, RED): golden-set regression for cluster_boost.
// Asserts: (1) baseline (flag off) retains a rare critical fact — no regression;
// (2) flag on activates the boost measurably (high-active-weight topic rises)
//     WITHOUT suppressing the critical fact. (2) fails RED until Phase 2d.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

const critical = {
  id: "critical-cred",
  text: "api key rotation policy for production",
  vector: [1, 0],
  category: "credential",
  scope: "global",
  importance: 0.9,
  timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::credentials" }),
};
const noisy = {
  id: "noisy-chat",
  text: "nice weather today chatting",
  vector: [0, 1],
  category: "fact",
  scope: "global",
  importance: 0.9,
  timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::small_talk" }),
};
const neutral = {
  id: "neutral-misc",
  text: "random project note here",
  vector: [1, 1],
  category: "fact",
  scope: "global",
  importance: 0.9,
  timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::misc" }),
};

const store = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [
      { entry: critical, score: 0.6 },
      { entry: noisy, score: 0.6 },
      { entry: neutral, score: 0.6 },
    ];
  },
  async bm25Search() {
    return [];
  },
  async hasId(id) {
    return [critical.id, noisy.id, neutral.id].includes(id);
  },
};
const embedder = { async embedQuery() { return [1, 0]; } };

// Utility-based active_weight: small_talk is frequent BUT low answer-gain → stays low.
const fakeProvider = {
  async getActiveWeight(topicId, _scope) {
    if (topicId === "global::small_talk") return 0.9;
    if (topicId === "global::credentials") return 0.1;
    return 0.5;
  },
};

// BASELINE (flag off): critical fact must be retained (no regression).
const offRetriever = createRetriever(
  store,
  embedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false,
    rerank: "none",
    minScore: 0,
    hardMinScore: 0,
    clusterBoostEnabled: false,
  },
  { topicClusterProvider: fakeProvider },
);
const offResults = await offRetriever.retrieve({
  query: "production key",
  limit: 5,
  scopeFilter: ["global"],
});
assert.ok(
  offResults.some((r) => r.entry.id === "critical-cred"),
  "BASELINE (flag off): critical fact must be retained — no regression",
);

// FLAG ON: boost must be ACTIVE (small_talk rises to rank 1) yet critical fact retained.
const onRetriever = createRetriever(
  store,
  embedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false,
    rerank: "none",
    minScore: 0,
    hardMinScore: 0,
    clusterBoostEnabled: true,
    clusterBoostTheta: { global: 0.08 },
  },
  { topicClusterProvider: fakeProvider },
);
const onResults = await onRetriever.retrieve({
  query: "production key",
  limit: 5,
  scopeFilter: ["global"],
});
assert.equal(
  onResults[0].entry.id,
  "noisy-chat",
  "FLAG ON: high-active-weight topic (small_talk) must rise to rank 1 via cluster_boost",
);
assert.ok(
  onResults.some((r) => r.entry.id === "critical-cred"),
  "FLAG ON: critical fact must NOT be suppressed by the boost",
);

console.log("OK: cluster-boost golden regression tests passed");
