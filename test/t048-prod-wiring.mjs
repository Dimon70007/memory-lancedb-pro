// T048-7 regression: protect against the two prod-wiring bugs found on push-to-prod.
// Bug A: config schema (openclaw.plugin.json) rejected clusterBoostEnabled
//        (additionalProperties:false) -> config flag never applied (reload skipped).
// Bug B: topicClusterProvider was never wired into the retriever in the host
//        (index.ts) -> cluster_boost silently never applied in production, even
//        though the isolated retriever unit test (cluster-boost-integration.mjs)
//        passed by injecting its own provider.
//
// This test exercises the REAL host wiring via buildMemoryRetriever() exported
// from index.ts, so a regression in the host (dropping the provider/sink) fails
// here instead of shipping silently to prod again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { buildMemoryRetriever } = jiti(path.resolve(__dirname, "../index.ts"));
const { DEFAULT_RETRIEVAL_CONFIG } = jiti(path.resolve(__dirname, "../src/retriever.ts"));

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String((e && e.stack) || e)]); }
}

const entryA = {
  id: "w-a", text: "hot topic content", vector: [1, 0], category: "fact",
  scope: "global", importance: 0.5, timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::hot" }),
};
const entryB = {
  id: "w-b", text: "cold topic content", vector: [0, 1], category: "fact",
  scope: "global", importance: 0.5, timestamp: Date.now(),
  metadata: JSON.stringify({ parent_topic_id: "global::cold" }),
};
const embedder = { async embedQuery() { return [1, 0]; } };
const hotProvider = {
  async getActiveWeight(topicId) { return topicId.includes("hot") ? 0.9 : 0.1; },
};

function makeStore({ topicProvider, recallTable }) {
  return {
    hasFtsSupport: true,
    getTopicClusters: () => topicProvider,
    getRecallLogTable: () => recallTable,
    trackCandidate: () => {},
    clearTrackedCandidates: () => {},
    async ensureInitialized() {},
    async vectorSearch() {
      return [
        { entry: entryA, score: 0.7 },
        { entry: entryB, score: 0.72 },
      ];
    },
    async bm25Search() { return []; },
    async hasId(id) { return id === entryA.id || id === entryB.id; },
  };
}

function buildCfg(extra) {
  return {
    ...DEFAULT_RETRIEVAL_CONFIG,
    rerank: "none", filterNoise: false, minScore: 0, hardMinScore: 0,
    clusterBoostTheta: { global: 0.08 },
    ...extra,
  };
}

// ---- Bug B: host wiring connects topicClusterProvider + sink ----
await run("BugB: scoreBoost strategy wired (non-null) via buildMemoryRetriever", async () => {
  const store = makeStore({ topicProvider: hotProvider, recallTable: null });
  const r = buildMemoryRetriever(store, embedder, buildCfg({ clusterBoostEnabled: true }), null);
  assert.ok(r.scoreBoost, "scoreBoost strategy must be wired (SOLID: retriever depends on ScoreBoost abstraction)");
  assert.equal(typeof r.scoreBoost.boost, "function", "scoreBoost must implement boost()");
});

await run("BugB: cluster_boost actually applies through host wiring (flag on)", async () => {
  const store = makeStore({ topicProvider: hotProvider, recallTable: null });
  const r = buildMemoryRetriever(store, embedder, buildCfg({ clusterBoostEnabled: true }), null);
  const res = await r.retrieve({ query: "topic", limit: 5, scopeFilter: ["global"] });
  assert.equal(res.length, 2, "both entries returned");
  const a = res.find((x) => x.entry.id === "w-a");
  const b = res.find((x) => x.entry.id === "w-b");
  // base: a=0.70 < b=0.72; boost: a += 0.08*0.9, b += 0.08*0.1 -> a should flip above b
  assert.ok(a.score > b.score, `hot(${a.score}) should outrank cold(${b.score}) via cluster_boost`);
  assert.ok(a.scoreFinal !== a.scoreRaw, "score_final should differ from score_raw (boost applied)");
});

await run("BugB: no boost when clusterBoostEnabled false (guard holds)", async () => {
  const store = makeStore({ topicProvider: hotProvider, recallTable: null });
  const r = buildMemoryRetriever(store, embedder, buildCfg({ clusterBoostEnabled: false }), null);
  const res = await r.retrieve({ query: "topic", limit: 5, scopeFilter: ["global"] });
  const a = res.find((x) => x.entry.id === "w-a");
  const b = res.find((x) => x.entry.id === "w-b");
  // without boost, base order preserved: b (0.72) > a (0.70)
  assert.ok(b.score > a.score, `without boost cold(${b.score}) should stay above hot(${a.score})`);
});

await run("BugB: recall_log sink wired + fires on retrieve", async () => {
  const logged = [];
  const fakeTable = { add: async (rows) => { logged.push(...rows); } };
  const store = makeStore({ topicProvider: hotProvider, recallTable: fakeTable });
  const r = buildMemoryRetriever(store, embedder, buildCfg({ clusterBoostEnabled: true }), null);
  assert.ok(r.recallLogSink, "recallLogSink must be wired");
  await r.retrieve({ query: "topic", limit: 5, scopeFilter: ["global"] });
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(logged.length > 0, `sink should log rows on retrieve (got ${logged.length})`);
});

// ---- Bug A: config schema accepts clusterBoostEnabled + clusterBoostTheta ----
await run("BugA: openclaw.plugin.json schema declares clusterBoostEnabled + clusterBoostTheta", async () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../openclaw.plugin.json"), "utf8"));
  const props = manifest.configSchema.properties.retrieval.properties;
  assert.ok(props.clusterBoostEnabled, "retrieval schema must declare clusterBoostEnabled");
  assert.equal(props.clusterBoostEnabled.type, "boolean", "clusterBoostEnabled must be boolean");
  assert.ok(props.clusterBoostTheta, "retrieval schema must declare clusterBoostTheta");
  assert.equal(props.clusterBoostTheta.type, "object", "clusterBoostTheta must be object");
  // A real config sample must not introduce unknown props (additionalProperties:false guard)
  const sample = { clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08 } };
  for (const k of Object.keys(sample)) {
    assert.ok(k in props, `config key '${k}' must be allowed by schema (was rejected before fix)`);
  }
});

let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n    " + msg); }
}
console.log(`\nT048-PROD-WIRING: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
