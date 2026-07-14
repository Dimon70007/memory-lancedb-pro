// T048-4a (TDD, RED): unit tests for topic-clusters pure functions.
// Module under test does NOT exist yet (Phase 2). Import fails → RED until implemented.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { normalizeTopicKey, computeActiveWeight, sigmoid } = jiti("../src/topic-clusters.ts");

// --- normalizeTopicKey: deterministic, no hardcoded list ---
assert.equal(normalizeTopicKey("OpenClaw Memory"), "openclaw_memory", "topic key: lower + space→_");
assert.equal(
  normalizeTopicKey("  Trading/Finance! "),
  "trading_finance_",
  "topic key: trim + punctuation→_",
);
assert.ok(
  normalizeTopicKey("A".repeat(50)).length <= 32,
  "topic key: sliced to <=32 chars",
);

// --- sigmoid bounds ---
for (const x of [-10, -1, 0, 1, 10]) {
  const s = sigmoid(x);
  assert.ok(s > 0 && s < 1, `sigmoid(${x}) must be in (0,1)`);
}
assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-9, "sigmoid(0) must equal 0.5");

// --- computeActiveWeight: cold-start = 0.5 (sigmoid(0)) ---
const w = { a: 0.4, b: 0.3, c: 0.2, d: 0.1 };
const cold = computeActiveWeight(
  { hit_rate: 0, recent_hits: 0, avg_answer_gain: 0, importance_mean: 0 },
  w,
);
assert.ok(Math.abs(cold - 0.5) < 1e-9, `cold-start active_weight must be 0.5, got ${cold}`);

// --- monotonic in hit_rate (utility, not frequency) ---
const low = computeActiveWeight(
  { hit_rate: 0.1, recent_hits: 0, avg_answer_gain: 0, importance_mean: 0.5 },
  w,
);
const high = computeActiveWeight(
  { hit_rate: 0.9, recent_hits: 0, avg_answer_gain: 0, importance_mean: 0.5 },
  w,
);
assert.ok(high > low, `higher hit_rate must raise active_weight (${low} < ${high})`);

// --- bounded ---
assert.ok(cold >= 0 && cold <= 1, "active_weight must stay within [0,1]");

console.log("OK: topic-clusters unit tests passed");
