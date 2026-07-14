// T048-4a (TDD, RED): integration test for cluster_boost in the retriever.
// Feature not implemented yet → FLAG-ON assertion fails (RED) until Phase 2d.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

// Two entries with EQUAL importance/timestamp/length but DIFFERENT base vector score
// and DIFFERENT topic active_weight. Only the cluster_boost should flip the order.
const entryA = {
  id: "boost-a",
  text: "alpha topic content",
  vector: [1, 0],
  category: "fact",
  scope: "global",
  importance: 0.5,
  timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::topic_hot" }),
};
const entryB = {
  id: "boost-b",
  text: "gamma topic content",
  vector: [0, 1],
  category: "fact",
  scope: "global",
  importance: 0.5,
  timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::topic_cold" }),
};

const store = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [
      { entry: entryA, score: 0.7 },
      { entry: entryB, score: 0.72 },
    ];
  },
  async bm25Search() {
    return [];
  },
  async hasId(id) {
    return id === entryA.id || id === entryB.id;
  },
};
const embedder = { async embedQuery() { return [1, 0]; } };

// Fake topic cluster provider: hot topic high active_weight, cold topic low.
const fakeProvider = {
  async getActiveWeight(topicId, _scope) {
    if (topicId === "global::topic_hot") return 0.9;
    if (topicId === "global::topic_cold") return 0.1;
    return 0.5;
  },
};

// FLAG ON → entryA (hot topic, +θ*0.9) should outscore entryB (cold, +θ*0.1).
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
  query: "content",
  limit: 5,
  scopeFilter: ["global"],
});
assert.equal(onResults.length, 2, "both entries returned (flag on)");
const onA = onResults.find((r) => r.entry.id === "boost-a").score;
const onB = onResults.find((r) => r.entry.id === "boost-b").score;
assert.ok(
  onA > onB,
  `FLAG ON: hot-topic entryA (${onA}) should outscore entryB (${onB}) via cluster_boost`,
);

// FLAG OFF → no boost; entryB's higher base score must win (no topic reordering).
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
  query: "content",
  limit: 5,
  scopeFilter: ["global"],
});
const offA = offResults.find((r) => r.entry.id === "boost-a").score;
const offB = offResults.find((r) => r.entry.id === "boost-b").score;
assert.ok(
  offB > offA,
  `FLAG OFF: entryB base score (${offB}) must exceed entryA (${offA}) — no cluster_boost applied`,
);

console.log("OK: cluster-boost integration tests passed");
