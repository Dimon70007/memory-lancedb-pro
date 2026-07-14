// T048-4f TDD: calibration harness on recall_log (spec §6, §9.3, Gate D).
// RED first: this fails until src/calibration.ts is implemented.
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const cal = jiti("../src/calibration.ts");

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, e.message]); }
}

const now = 1_700_000_000_000;
const WEEK = 7 * 24 * 3600 * 1000;

function mkTopics() {
  return new Map([
    ["global::hot", { topic_id: "global::hot", scope: "global", doc_count: 5, hit_count: 4, last_hit_ts: now, avg_importance: 0.9, avg_confidence: 0.8, active_weight: 0.5, decay_rate: 0.01, status: "active", metadata: "{}" }],
    ["global::cold", { topic_id: "global::cold", scope: "global", doc_count: 2, hit_count: 0, last_hit_ts: now - 100 * WEEK, avg_importance: 0.2, avg_confidence: 0.3, active_weight: 0.1, decay_rate: 0.01, status: "active", metadata: "{}" }],
  ]);
}

function mkRows() {
  return [
    { query_id: "q1::1::a", session_key: "global", query_text: "q1", candidate_id: "a", topic_id: "global::hot", score_raw: 0.7, score_final: 0.74, used_in_answer: true, user_feedback: 1, recall_ts: now, metadata: "{}" },
    { query_id: "q1::1::b", session_key: "global", query_text: "q1", candidate_id: "b", topic_id: "global::cold", score_raw: 0.72, score_final: 0.72, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
    { query_id: "q2::1::c", session_key: "global", query_text: "q2", candidate_id: "c", topic_id: "global::hot", score_raw: 0.6, score_final: 0.64, used_in_answer: true, user_feedback: 1, recall_ts: now, metadata: "{}" },
    { query_id: "q2::1::d", session_key: "global", query_text: "q2", candidate_id: "d", topic_id: "global::cold", score_raw: 0.65, score_final: 0.65, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
  ];
}

// §6 c-term: avg_answer_gain = sum(user_feedback where not null) / count(used_in_answer)
await run("§6 computeAvgAnswerGain = feedback_sum / used_count", async () => {
  const g = cal.computeAvgAnswerGain(mkRows());
  assert.equal(g, 1.0, "two used rows, +1 each → 1.0");
});

// §6 active_weight = sigmoid(a·hit_rate + b·recent_hits + c·avg_answer_gain + d·importance_mean)
await run("§6 computeActiveWeight matches sigmoid formula (default params)", async () => {
  const stats = cal.computeTopicStats(mkRows(), mkTopics(), now)[0]; // global::hot
  const aw = cal.computeActiveWeight(stats, cal.DEFAULT_CALIBRATION);
  const x = 0.4 * stats.hit_rate + 0.3 * stats.recent_hits + 0.2 * stats.avg_answer_gain + 0.1 * stats.importance_mean;
  const expected = 1 / (1 + Math.exp(-x));
  assert.ok(Math.abs(aw - expected) < 1e-9, `aw=${aw}, expected=${expected}`);
  assert.ok(aw > 0.5, "hot topic with used+feedback → weight > 0.5");
});

// §6 intent: utility (hit_rate + feedback) dominates raw frequency.
// At EQUAL recent_hits, a useful topic (hit_rate=1, gain=1) must outrank a noisy one (hit_rate=0, gain=0).
await run("§6 useful topic outranks noisy at equal recent_hits", async () => {
  const rows = [
    { query_id: "q3::1::e", session_key: "global", query_text: "q3", candidate_id: "e", topic_id: "global::noisy", score_raw: 0.5, score_final: 0.5, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
    { query_id: "q3::1::f", session_key: "global", query_text: "q3", candidate_id: "f", topic_id: "global::noisy", score_raw: 0.5, score_final: 0.5, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
    { query_id: "q4::1::g", session_key: "global", query_text: "q4", candidate_id: "g", topic_id: "global::useful", score_raw: 0.5, score_final: 0.5, used_in_answer: true, user_feedback: 1, recall_ts: now, metadata: "{}" },
  ];
  const topics = new Map([
    ["global::noisy", { topic_id: "global::noisy", scope: "global", doc_count: 50, hit_count: 0, last_hit_ts: now, avg_importance: 0.1, avg_confidence: 0.1, active_weight: 0.1, decay_rate: 0.01, status: "active", metadata: "{}" }],
    ["global::useful", { topic_id: "global::useful", scope: "global", doc_count: 3, hit_count: 1, last_hit_ts: now, avg_importance: 0.9, avg_confidence: 0.8, active_weight: 0.5, decay_rate: 0.01, status: "active", metadata: "{}" }],
  ]);
  const stats = cal.computeTopicStats(rows, topics, now);
  const noisy = stats.find((s) => s.topic_id === "global::noisy");
  const useful = stats.find((s) => s.topic_id === "global::useful");
  const awNoisy = cal.computeActiveWeight(noisy, cal.DEFAULT_CALIBRATION);
  const awUseful = cal.computeActiveWeight(useful, cal.DEFAULT_CALIBRATION);
  assert.ok(awUseful > awNoisy, `useful (${awUseful}) should outrank noisy (${awNoisy}) at equal recent_hits`);
});

// §6 formula exactness for a noisy topic (raw recent_hits drives weight per literal spec)
await run("§6 noisy topic weight matches literal sigmoid formula", async () => {
  const rows = [
    { query_id: "q3::1::e", session_key: "global", query_text: "q3", candidate_id: "e", topic_id: "global::noisy", score_raw: 0.5, score_final: 0.5, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
    { query_id: "q3::1::f", session_key: "global", query_text: "q3", candidate_id: "f", topic_id: "global::noisy", score_raw: 0.5, score_final: 0.5, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
  ];
  const topics = new Map([["global::noisy", { topic_id: "global::noisy", scope: "global", doc_count: 50, hit_count: 0, last_hit_ts: now, avg_importance: 0.1, avg_confidence: 0.1, active_weight: 0.1, decay_rate: 0.01, status: "active", metadata: "{}" }]]);
  const stats = cal.computeTopicStats(rows, topics, now)[0];
  const aw = cal.computeActiveWeight(stats, cal.DEFAULT_CALIBRATION);
  const x = 0.4 * stats.hit_rate + 0.3 * stats.recent_hits + 0.2 * stats.avg_answer_gain + 0.1 * stats.importance_mean;
  const expected = 1 / (1 + Math.exp(-x));
  assert.ok(Math.abs(aw - expected) < 1e-9, `aw=${aw}, expected=${expected}`);
});

// Gate D: no critical regression when critical fact is used & not demoted
await run("Gate D detectCriticalRegression = false when critical used & not demoted", async () => {
  const reg = cal.detectCriticalRegression(mkRows(), new Set(["a"]));
  assert.equal(reg, false, "critical 'a' is used_in_answer, not demoted");
});

// Gate D: regression when a critical fact is demoted by boost (used under raw, score dropped)
await run("Gate D detectCriticalRegression = true when critical demoted by boost", async () => {
  const rows = [
    { query_id: "q1::1::crit", session_key: "global", query_text: "q1", candidate_id: "crit", topic_id: "global::cold", score_raw: 0.8, score_final: 0.5, used_in_answer: false, user_feedback: null, recall_ts: now, metadata: "{}" },
  ];
  const reg = cal.detectCriticalRegression(rows, new Set(["crit"]));
  assert.equal(reg, true, "critical demoted (score_final < score_raw, not used) → regression");
});

// Gate D: evaluateGate passes when gain >= baseline AND no regression
await run("Gate D evaluateGate pass when gain>=baseline & no regression", async () => {
  const res = cal.evaluateGate({ rows: mkRows(), baseline: 0.5, criticalIds: new Set(["a"]), params: cal.DEFAULT_CALIBRATION });
  assert.equal(res.pass, true, "gain=1.0>=0.5, no regression → pass");
  assert.equal(res.regression, false);
  assert.ok(res.avgAnswerGain >= 0.5);
});

// Gate D: evaluateGate fails when gain < baseline
await run("Gate D evaluateGate fail when gain<baseline", async () => {
  const res = cal.evaluateGate({ rows: mkRows(), baseline: 2.0, criticalIds: new Set(["a"]), params: cal.DEFAULT_CALIBRATION });
  assert.equal(res.pass, false, "gain=1.0 < baseline 2.0 → fail");
});

// tuneParameters: returns params from grid that improve used-candidate rank gain without regression
await run("tuneParameters returns grid params improving rank-gain, no regression", async () => {
  const rows = mkRows();
  const topics = mkTopics();
  const tuned = cal.tuneParameters({ rows, topics, baseline: 0.5, criticalIds: new Set(["a"]), now });
  // valid grid values
  assert.ok([0.04, 0.08, 0.12].includes(tuned.theta), `theta in grid, got ${tuned.theta}`);
  assert.ok([0.3, 0.4, 0.5].includes(tuned.a));
  // improvement over default: simulate both, compare meanUsedRankGain
  const rescoredTuned = cal.simulateRescore(rows, topics, tuned, now);
  const rescoredDefault = cal.simulateRescore(rows, topics, cal.DEFAULT_CALIBRATION, now);
  const gainTuned = cal.meanUsedRankGain(rescoredTuned);
  const gainDefault = cal.meanUsedRankGain(rescoredDefault);
  assert.ok(gainTuned >= gainDefault - 1e-9, `tuned gain (${gainTuned}) >= default gain (${gainDefault})`);
  // no regression under tuned params
  assert.equal(cal.detectCriticalRegression(rescoredTuned, new Set(["a"])), false);
});

// ---- report ----
let failed = 0;
for (const [ok, name, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + msg}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} calibration harness tests passed`);
process.exit(failed ? 1 : 0);
