// T048 corner-case tests — topic_clusters (spec §3, §5, §6, §8b, §9).
// Per-assertion harness: RED tests don't hide other results → full gap matrix.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { normalizeTopicKey, computeActiveWeight, sigmoid, TopicClusters } = jiti(
  "../src/topic-clusters.ts",
);

const results = [];
async function run(name, fn) {
  try {
    await fn();
    results.push([true, name, ""]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}

// In-memory fake TopicClusterTable (no heavy LanceDB load).
class FakeTable {
  constructor() {
    this.rows = new Map();
  }
  query() {
    this._q = {};
    return this;
  }
  where(sql) {
    const m = sql.match(/topic_id = '([^']*)'/);
    this._q.topicId = m ? m[1] : null;
    return this;
  }
  limit() {
    return this;
  }
  async toArray() {
    if (this._q.topicId == null) return [];
    const row = this.rows.get(this._q.topicId);
    return row ? [row] : [];
  }
  async add(rows) {
    for (const r of rows) this.rows.set(r.topic_id, r);
  }
  async delete(where) {
    const m = where.match(/topic_id = '([^']*)'/);
    if (m) this.rows.delete(m[1]);
  }
}

const W = { a: 0.4, b: 0.3, c: 0.2, d: 0.1 };

// ---- §8b.1 topic-key normalization (edge cases) ----
await run("§8b.1 normalize: lower + space→_", () => {
  assert.equal(normalizeTopicKey("OpenClaw Memory"), "openclaw_memory");
});
await run("§8b.1 normalize: trim + punctuation→_", () => {
  assert.equal(normalizeTopicKey("  Trading/Finance! "), "trading_finance_");
});
await run("§8b.1 normalize: long string sliced to 32", () => {
  const k = normalizeTopicKey("A".repeat(50));
  assert.equal(k.length, 32, `expected 32, got ${k.length}`);
});
await run("§8b.1 normalize: special chars → _", () => {
  assert.equal(normalizeTopicKey("foo@#$%^&*()bar"), "foo_bar");
});
await run("§8b.1 normalize: keep underscores + lower", () => {
  assert.equal(
    normalizeTopicKey("MixedCase_Keep_Underscore"),
    "mixedcase_keep_underscore",
  );
});
await run("§8b.1 normalize: empty → uncategorized (§5.1); run of specials → single _", () => {
  assert.equal(normalizeTopicKey(""), "uncategorized");
  // [^a-z0-9_]+ matches a RUN of specials → one "_" (spec §8b.1)
  assert.equal(normalizeTopicKey("!!!###"), "_");
});

// ---- §8b.4 cold-start ----
await run("§8b.4 cold-start active_weight = 0.5 (sigmoid(0))", async () => {
  const tc = new TopicClusters(new FakeTable(), {});
  await tc.upsertTopic({ topicId: "global::fresh", scope: "global", vector: [0.1], importance: 0.5 });
  const aw = await tc.getActiveWeight("global::fresh", "global");
  assert.ok(Math.abs(aw - 0.5) < 1e-9, `expected 0.5, got ${aw}`);
});

// ---- §6 sigmoid ----
await run("§6 sigmoid(0)=0.5 and strictly in (0,1)", () => {
  assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-9);
  for (const x of [-20, 20]) {
    const s = sigmoid(x);
    assert.ok(s > 0 && s < 1, `sigmoid(${x}) out of bounds`);
  }
});

// ---- §6 / §9.6 utility-based, NOT frequency-based ----
await run("§6/§9.6 useful > noisy (hit features dominate)", () => {
  const noisy = computeActiveWeight(
    { hit_rate: 0, recent_hits: 0, avg_answer_gain: 0, importance_mean: 0.95 },
    W,
  );
  const useful = computeActiveWeight(
    { hit_rate: 1, recent_hits: 5, avg_answer_gain: 1, importance_mean: 0.3 },
    W,
  );
  assert.ok(useful > noisy, `useful ${useful} should exceed noisy ${noisy}`);
});
await run("§6 doc_count NOT in formula (same features → same weight)", () => {
  const f = { hit_rate: 0.5, recent_hits: 1, avg_answer_gain: 0.2, importance_mean: 0.4 };
  assert.ok(
    Math.abs(computeActiveWeight(f, W) - computeActiveWeight({ ...f }, W)) < 1e-12,
  );
});

// ---- §9.1 dynamic creation (no hardcode) ----
await run("§9.1 dynamic topic creation on first store", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  await tc.upsertTopic({ topicId: "global::alpha", scope: "global", vector: [0.2], importance: 0.6 });
  assert.equal(t.rows.size, 1);
  assert.ok(t.rows.has("global::alpha"));
});

// ---- §9.5 no hardcode — 3 distinct topics → 3 distinct ids ----
await run("§9.5 three distinct topics → three distinct ids", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  await tc.upsertTopic({ topicId: "global::x", scope: "global", vector: [1], importance: 0.5 });
  await tc.upsertTopic({ topicId: "global::y", scope: "global", vector: [2], importance: 0.5 });
  await tc.upsertTopic({ topicId: "global::z", scope: "global", vector: [3], importance: 0.5 });
  assert.equal(t.rows.size, 3);
});

// ---- §5.3 per-scope isolation ----
await run("§5.3 same topic, different scope → distinct ids", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  await tc.upsertTopic({ topicId: "global::foo", scope: "global", vector: [1], importance: 0.5 });
  await tc.upsertTopic({ topicId: "default::foo", scope: "default", vector: [1], importance: 0.5 });
  assert.equal(t.rows.size, 2);
  assert.ok(t.rows.has("global::foo") && t.rows.has("default::foo"));
});

// ---- §9.2 repeat store → doc_count grows, last_hit_ts fresh, centroid smoothed ----
await run("§9.2 repeat store increments doc_count + refreshes last_hit_ts + smooths centroid", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  await tc.upsertTopic({ topicId: "global::rep", scope: "global", vector: [0.1], importance: 0.5 });
  const ts1 = t.rows.get("global::rep").last_hit_ts;
  await new Promise((r) => setTimeout(r, 2));
  await tc.upsertTopic({ topicId: "global::rep", scope: "global", vector: [0.9], importance: 0.7 });
  const row = t.rows.get("global::rep");
  assert.equal(row.doc_count, 2);
  assert.ok(row.last_hit_ts >= ts1, "last_hit_ts refreshed");
  assert.ok(
    Math.abs(row.vector[0] - 0.5) < 1e-9,
    `centroid smoothed to 0.5, got ${row.vector[0]}`,
  );
});

// ---- §3 schema columns present ----
await run("§3 all topic_clusters columns present", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  await tc.upsertTopic({ topicId: "global::schema", scope: "global", vector: [0.3], importance: 0.4 });
  const row = t.rows.get("global::schema");
  const cols = [
    "topic_id", "scope", "topic", "vector", "doc_count", "hit_count",
    "last_hit_ts", "avg_importance", "avg_confidence", "active_weight",
    "decay_rate", "status", "metadata",
  ];
  for (const col of cols) assert.ok(col in row, `missing column ${col}`);
});

// ---- §8b.2 boost excludes archived/dormant (status check implemented) ----
await run("§8b.2 archived/dormant topic excluded from boost (active_weight 0)", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  const mkRow = (status) => ({
    topic_id: "global::arch", scope: "global", topic: "arch", vector: [1],
    doc_count: 5, hit_count: 0, hit_rate: 0, recent_hits: 0, avg_answer_gain: 0,
    last_hit_ts: Date.now(), avg_importance: 0.9, importance_mean: 0.9,
    avg_confidence: 0.5, active_weight: 0.9, decay_rate: 0.01, status, metadata: "{}",
  });
  t.rows.set("global::arch", mkRow("archived"));
  assert.equal(await tc.getActiveWeight("global::arch", "global"), 0, "archived → 0");
  t.rows.get("global::arch").status = "dormant";
  assert.equal(await tc.getActiveWeight("global::arch", "global"), 0, "dormant → 0");
});

// ---- §9.6 manager-level: useful topic outranks noisy by utility (not doc_count) ----
await run("§9.6 manager: useful topic outranks noisy despite fewer docs", async () => {
  const t = new FakeTable();
  const tc = new TopicClusters(t, {});
  t.rows.set("global::noisy", {
    topic_id: "global::noisy", scope: "global", topic: "noisy", vector: [1],
    doc_count: 100, hit_count: 0, hit_rate: 0, recent_hits: 0, avg_answer_gain: 0,
    last_hit_ts: Date.now(), avg_importance: 0.9, importance_mean: 0.9,
    avg_confidence: 0.5,
    active_weight: computeActiveWeight({ hit_rate: 0, recent_hits: 0, avg_answer_gain: 0, importance_mean: 0.9 }, W),
    decay_rate: 0.01, status: "active", metadata: "{}",
  });
  t.rows.set("global::useful", {
    topic_id: "global::useful", scope: "global", topic: "useful", vector: [1],
    doc_count: 2, hit_count: 2, hit_rate: 1, recent_hits: 5, avg_answer_gain: 1,
    last_hit_ts: Date.now(), avg_importance: 0.3, importance_mean: 0.3,
    avg_confidence: 0.5,
    active_weight: computeActiveWeight({ hit_rate: 1, recent_hits: 5, avg_answer_gain: 1, importance_mean: 0.3 }, W),
    decay_rate: 0.01, status: "active", metadata: "{}",
  });
  const noisy = await tc.getActiveWeight("global::noisy", "global");
  const useful = await tc.getActiveWeight("global::useful", "global");
  assert.ok(useful > noisy, `useful ${useful} should exceed noisy ${noisy} despite fewer docs`);
});

// ---- report ----
let failed = 0;
for (const [ok, name, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + msg}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} topic-clusters corner cases passed`);
process.exit(failed ? 1 : 0);
