// T048 corner-case tests — cluster_boost scoring (spec §7, §9.4, §9.6).
// Per-assertion harness: RED tests don't hide other results → full gap matrix.
//
// NOTE on score math: cluster_boost is added right AFTER rerank and BEFORE
// recencyBoost/importanceWeight/lengthNorm/timeDecay, which transform the
// score. So final != base + θ·active_weight exactly. We assert RELATIVE
// behavior (boost raises score vs OFF; θ=0 == OFF; per-scope isolation;
// ordering flip; determinism; pipeline intact) — which is what the spec pins.
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
// Freeze time so time-decay/recency transforms are deterministic. Without this,
// two retrieve() calls a few ms apart yield ~1e-7 score drift (not a boost bug),
// which breaks the determinism and per-scope-isolation assertions below.
const REAL_NOW = Date.now;
let FROZEN_NOW = 1_700_000_000_000;
Date.now = () => FROZEN_NOW;
const mkStore = (entries) => ({
  hasFtsSupport: true,
  async vectorSearch() {
    return entries.map((e) => ({ entry: e, score: e._base }));
  },
  async bm25Search() {
    return [];
  },
  async hasId(id) {
    return entries.some((e) => e.id === id);
  },
});

// Build a retriever and return the score of entry `id` under given config.
async function scoreOf(entry, cfgPatch, provider) {
  const r = createRetriever(
    mkStore([entry]),
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0, ...cfgPatch },
    { topicClusterProvider: provider },
  );
  const res = await r.retrieve({ query: "x", limit: 5, scopeFilter: [entry.scope] });
  const hit = res.find((x) => x.entry.id === entry.id);
  return hit ? hit.score : null;
}

const hotProvider = { async getActiveWeight(id) { return id === "global::hot" ? 0.9 : 0.1; } };

// ---- §7 / §9 gate: default OFF ----
await run("§7/§9 default clusterBoostEnabled === false", () => {
  assert.equal(DEFAULT_RETRIEVAL_CONFIG.clusterBoostEnabled, false, "default must be false (CONDITIONAL-GO)");
});

// ---- §7 flag OFF → no boost, base order preserved ----
await run("§7 flag OFF → no reorder (base score wins)", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const eB = { id: "b", text: "b", vector: [0, 1], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::cold" }), _base: 0.72 };
  const r = createRetriever(
    mkStore([eA, eB]),
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0, clusterBoostEnabled: false },
    { topicClusterProvider: { async getActiveWeight() { return 0.9; } } },
  );
  const res = await r.retrieve({ query: "x", limit: 5, scopeFilter: ["global"] });
  const sa = res.find((r) => r.entry.id === "a").score;
  const sb = res.find((r) => r.entry.id === "b").score;
  assert.ok(sb > sa, `OFF: b(${sb}) must exceed a(${sa})`);
});

// ---- §7 flag ON → boost raises score vs OFF (positive delta) ----
await run("§7 flag ON → score raised vs OFF (positive boost delta)", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const off = await scoreOf(eA, { clusterBoostEnabled: false }, hotProvider);
  const on = await scoreOf(eA, { clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08 } }, hotProvider);
  assert.ok(on > off, `ON(${on}) must exceed OFF(${off}) — boost must raise score`);
  assert.ok(on - off > 0, "boost delta must be positive");
});

// ---- §7 per-scope θ=0 → no boost (ON == OFF) ----
await run("§7 per-scope θ=0 → no change vs OFF", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const off = await scoreOf(eA, { clusterBoostEnabled: false }, hotProvider);
  const on = await scoreOf(eA, { clusterBoostEnabled: true, clusterBoostTheta: { global: 0 } }, hotProvider);
  assert.ok(Math.abs(on - off) < 1e-12, `θ=0 → ON(${on}) must equal OFF(${off})`);
});

// ---- §7 per-scope isolation: boosting scope A doesn't affect scope B ----
await run("§7 per-scope isolation (scope B unaffected by scope A θ)", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const eB = { id: "b", text: "b", vector: [0, 1], category: "fact", scope: "default", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "default::hot" }), _base: 0.7 };
  const cfg = { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0, clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08, default: 0 } };
  const r = createRetriever(mkStore([eA, eB]), embedder, cfg, { topicClusterProvider: { async getActiveWeight() { return 0.9; } } });
  const res = await r.retrieve({ query: "x", limit: 5, scopeFilter: ["global", "default"] });
  const sa = res.find((r) => r.entry.id === "a").score;
  const sb = res.find((r) => r.entry.id === "b").score;
  // Compare B against the SAME 2-entry retriever with boost OFF (apples-to-apples).
  // Using a separate 1-entry scoreOf() path introduced ~1e-7 cross-path float
  // noise from multi-candidate normalization, not a real boost leak.
  const rOff = createRetriever(mkStore([eA, eB]), embedder, { ...cfg, clusterBoostEnabled: false }, { topicClusterProvider: { async getActiveWeight() { return 0.9; } } });
  const resOff = await rOff.retrieve({ query: "x", limit: 5, scopeFilter: ["global", "default"] });
  const offA = resOff.find((r) => r.entry.id === "a").score;
  const offB = resOff.find((r) => r.entry.id === "b").score;
  assert.ok(sa > offA, `global boosted: ON(${sa}) > OFF(${offA})`);
  assert.ok(Math.abs(sb - offB) < 1e-12, `default not boosted: ON(${sb}) == OFF(${offB})`);
});

// ---- §7 deterministic: same input → same output ----
await run("§7 deterministic boost (repeatable)", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const cfg = { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0, clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08 } };
  const p = { topicClusterProvider: { async getActiveWeight() { return 0.9; } } };
  const s1 = await scoreOf(eA, cfg, p);
  const s2 = await scoreOf(eA, cfg, p);
  assert.ok(Math.abs(s1 - s2) < 1e-12, `non-deterministic: ${s1} vs ${s2}`);
});

// ---- §9.4 doesn't break pipeline (finite scores, valid length) ----
await run("§9.4 pipeline intact (finite score, valid length)", async () => {
  const eA = { id: "a", text: "a", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::hot" }), _base: 0.7 };
  const r = createRetriever(
    mkStore([eA]),
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0, clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08 } },
    { topicClusterProvider: { async getActiveWeight() { return 0.9; } } },
  );
  const res = await r.retrieve({ query: "x", limit: 5, scopeFilter: ["global"] });
  assert.equal(res.length, 1);
  assert.ok(Number.isFinite(res[0].score), "score must be finite");
});

// ---- §9.6 noisy vs useful reorder via boost ----
await run("§9.6 noisy vs useful reorder (useful rises above noisy)", async () => {
  const noisy = { id: "noisy", text: "n", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::noisy" }), _base: 0.70 };
  const useful = { id: "useful", text: "u", vector: [0, 1], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::useful" }), _base: 0.70 };
  const r = createRetriever(
    mkStore([noisy, useful]),
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, rerank: "none", minScore: 0, hardMinScore: 0, clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08 } },
    { topicClusterProvider: { async getActiveWeight(id) { return id === "global::useful" ? 0.9 : 0.1; } } },
  );
  const res = await r.retrieve({ query: "x", limit: 5, scopeFilter: ["global"] });
  const su = res.find((r) => r.entry.id === "useful").score;
  const sn = res.find((r) => r.entry.id === "noisy").score;
  assert.ok(su > sn, `useful ${su} should exceed noisy ${sn}`);
});

// ---- report ----
let failed = 0;
for (const [ok, name, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + msg}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} cluster-boost corner cases passed`);
process.exit(failed ? 1 : 0);
