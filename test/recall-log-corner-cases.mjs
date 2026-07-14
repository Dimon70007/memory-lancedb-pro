// T048 corner-case tests — recall_log (spec §4, §9.3).
// Per-assertion harness: RED tests don't hide other results → full gap matrix.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

const results = [];
async function run(name, fn) {
  try {
    await fn();
    results.push([true, name, ""]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}

const embedder = { async embedQuery() { return [1, 0]; } };
const mkStore = (entries) => ({
  hasFtsSupport: true,
  async vectorSearch() {
    return entries.map((e) => ({ entry: e, score: e._base }));
  },
  async bm25Search() { return []; },
  async hasId(id) { return entries.some((e) => e.id === id); },
});

function makeRetriever(entries, sink, boost = false) {
  const cfg = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0,
    clusterBoostEnabled: boost, clusterBoostTheta: { global: 0.08 },
  };
  const opts = {
    topicClusterProvider: { async getActiveWeight(id) { return id === "global::hot" ? 0.9 : 0; } },
    recallLogSink: sink,
  };
  return createRetriever(mkStore(entries), embedder, cfg, opts);
}

// §9.3: one recall_log row per returned candidate.
await run("§9.3 one row per returned candidate", async () => {
  const captured = [];
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const eB = { id: "b", text: "b", vector: [0, 1], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::cold" }), _base: 0.72 };
  const r = makeRetriever([eA, eB], { async logBatch(es) { captured.push(...es); } }, true);
  const res = await r.retrieve({ query: "q", limit: 5, scopeFilter: ["global"] });
  assert.equal(res.length, 2);
  assert.equal(captured.length, 2, "one row per candidate");
});

// §4: all schema columns present + sane defaults.
await run("§4 all recall_log schema fields present + defaults", async () => {
  const captured = [];
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const r = makeRetriever([eA], { async logBatch(es) { captured.push(...es); } }, true);
  await r.retrieve({ query: "q", limit: 5, scopeFilter: ["global"] });
  const e = captured[0];
  for (const col of ["query_id", "session_key", "query_text", "candidate_id", "topic_id", "score_raw", "score_final", "used_in_answer", "user_feedback", "recall_ts", "metadata"]) {
    assert.ok(col in e, `missing column ${col}`);
  }
  assert.equal(e.used_in_answer, false, "used_in_answer defaults false (post-hoc fill)");
  assert.equal(e.user_feedback, null, "user_feedback defaults null");
  assert.ok(typeof e.recall_ts === "number", "recall_ts is number");
  assert.ok(typeof e.query_text === "string" && e.query_text.length > 0, "query_text present");
});

// §4 / §9.3: topic_id derived from metadata.parent_topic_id.
await run("§9.3 topic_id from metadata.parent_topic_id", async () => {
  const captured = [];
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const r = makeRetriever([eA], { async logBatch(es) { captured.push(...es); } }, true);
  await r.retrieve({ query: "q", limit: 5, scopeFilter: ["global"] });
  assert.equal(captured[0].topic_id, "global::hot");
});

// §4: score_raw (pre-boost) vs score_final (post-boost) relationship.
await run("§4 score_raw vs score_final (boost direction)", async () => {
  const captured = [];
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const eB = { id: "b", text: "b", vector: [0, 1], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::cold" }), _base: 0.72 };
  const r = makeRetriever([eA, eB], { async logBatch(es) { captured.push(...es); } }, true);
  await r.retrieve({ query: "q", limit: 5, scopeFilter: ["global"] });
  const a = captured.find((x) => x.candidate_id === "a");
  const b = captured.find((x) => x.candidate_id === "b");
  assert.ok(a.score_final > a.score_raw, "boosted: final > raw");
  assert.ok(Math.abs(b.score_final - b.score_raw) < 1e-12, "aw=0: final == raw");
});

// Robustness: a throwing sink must NOT break retrieval (non-fatal).
await run("robustness: failing sink does not break retrieve", async () => {
  const failingSink = {
    async logBatch() {
      throw new Error("sink down");
    },
  };
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const r = makeRetriever([eA], failingSink, true);
  // Must resolve (not reject) despite sink throwing.
  const res = await r.retrieve({ query: "q", limit: 5, scopeFilter: ["global"] });
  assert.equal(res.length, 1, "retrieve still returns results when sink fails");
});

// Optional sink: retrieve works with no recallLogSink at all.
await run("optional: no sink → retrieve works", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const r = makeRetriever([eA], undefined, true);
  const res = await r.retrieve({ query: "q", limit: 5, scopeFilter: ["global"] });
  assert.equal(res.length, 1);
});

// ---- report ----
let failed = 0;
for (const [ok, name, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + msg}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} recall-log corner cases passed`);
process.exit(failed ? 1 : 0);
