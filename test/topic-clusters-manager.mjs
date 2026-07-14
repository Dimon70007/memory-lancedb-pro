// T048-4b (TDD): TopicClusters manager — dynamic creation, upsert aggregates,
// getActiveWeight, no hardcoded topic list. Uses an in-memory fake table
// (no heavy LanceDB load) to validate the manager logic fast.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { TopicClusters } = jiti("../src/topic-clusters.ts");

// Minimal in-memory implementation of the TopicClusterTable interface.
class FakeTable {
  constructor() {
    this.rows = new Map();
    this._q = {};
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

const table = new FakeTable();
const tc = new TopicClusters(table, {});

// 1. Dynamic creation (no hardcoded list)
await tc.upsertTopic({ topicId: "global::trading", scope: "global", vector: [0.1, 0.2], importance: 0.9 });
assert.equal(table.rows.size, 1, "first upsert creates a topic row");
const row1 = table.rows.get("global::trading");
assert.equal(row1.doc_count, 1, "doc_count starts at 1");
assert.ok(row1.active_weight > 0 && row1.active_weight < 1, "active_weight in (0,1)");

// 2. Repeat upsert increments doc_count + updates centroid (exp smoothing)
await tc.upsertTopic({ topicId: "global::trading", scope: "global", vector: [0.3, 0.4], importance: 0.7 });
const row2 = table.rows.get("global::trading");
assert.equal(row2.doc_count, 2, "doc_count increments on repeat");
// centroid: prev [0.1,0.2], alpha=1/2, new [0.3,0.4] => [0.2, 0.3]
assert.ok(
  Math.abs(row2.vector[0] - 0.2) < 1e-9 && Math.abs(row2.vector[1] - 0.3) < 1e-9,
  `centroid updated via exp smoothing, got [${row2.vector}]`,
);

// 3. getActiveWeight returns stored weight
const aw = await tc.getActiveWeight("global::trading", "global");
assert.ok(Math.abs(aw - row2.active_weight) < 1e-9, "getActiveWeight returns stored weight");

// 4. Distinct topics => distinct rows (no hardcoded list)
await tc.upsertTopic({ topicId: "global::robotics", scope: "global", vector: [0.5, 0.6], importance: 0.8 });
assert.equal(table.rows.size, 2, "second distinct topic creates a new row");

// 5. Unknown topic => 0
assert.equal(await tc.getActiveWeight("global::nope", "global"), 0, "unknown topic => active_weight 0");

// 6. topicId helper normalizes
assert.equal(
  TopicClusters.topicId("global", "OpenClaw Memory"),
  "global::openclaw_memory",
  "topicId helper normalizes topic key",
);

console.log("OK: topic-clusters manager tests passed");
