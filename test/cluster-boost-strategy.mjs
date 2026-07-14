// T048-9 (SOLID): isolated unit test for ClusterBoostStrategy (SRP/OCP/DIP).
// The boost scoring logic is extracted from the retriever into its own strategy
// class behind the ScoreBoost interface, so the retriever depends on an
// abstraction and new boost strategies can be added without modifying it.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { ClusterBoostStrategy } = jiti(path.resolve(__dirname, "../src/cluster-boost.ts"));

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String((e && e.stack) || e)]); }
}

const mkEntry = (id, topicId) => ({
  id,
  metadata: JSON.stringify(topicId ? { parent_topic_id: topicId } : {}),
  scope: "global",
});

const mkCandidate = (id, topicId, score = 0.5) => ({
  entry: mkEntry(id, topicId),
  score,
  sources: {},
});

const hotProvider = {
  async getActiveWeight(topicId) { return topicId.includes("hot") ? 0.9 : 0.1; },
};

await run("boost applies theta*active_weight when enabled", async () => {
  const s = new ClusterBoostStrategy(hotProvider, 0.08);
  const cands = [mkCandidate("a", "global::hot", 0.5), mkCandidate("b", "global::cold", 0.5)];
  const out = await s.boost(cands, { clusterBoostEnabled: true, clusterBoostTheta: { global: 0.08, default: 0.08 } });
  const a = out.find((c) => c.entry.id === "a");
  const b = out.find((c) => c.entry.id === "b");
  // a: 0.5 + 0.08*0.9 = 0.572 ; b: 0.5 + 0.08*0.1 = 0.508
  assert.ok(Math.abs(a.score - 0.572) < 1e-9, `hot score ${a.score}`);
  assert.ok(Math.abs(b.score - 0.508) < 1e-9, `cold score ${b.score}`);
  assert.ok(a.score > b.score, "hot should outrank cold");
  assert.equal(a.sources.clusterBoost.activeWeight, 0.9);
});

await run("disabled: no boost, scores unchanged (snapshot still set)", async () => {
  const s = new ClusterBoostStrategy(hotProvider, 0.08);
  const cands = [mkCandidate("a", "global::hot", 0.5)];
  const out = await s.boost(cands, { clusterBoostEnabled: false, clusterBoostTheta: { default: 0.08 } });
  assert.equal(out[0].score, 0.5, "score must be unchanged when disabled");
  assert.equal(out[0].scoreRaw, 0.5, "scoreRaw snapshot set");
  assert.equal(out[0].scoreFinal, 0.5, "scoreFinal snapshot set");
  assert.ok(!out[0].sources.clusterBoost, "no clusterBoost source when disabled");
});

await run("provider throws -> candidate skipped (non-fatal)", async () => {
  const faulty = { async getActiveWeight() { throw new Error("boom"); } };
  const s = new ClusterBoostStrategy(faulty, 0.08);
  const cands = [mkCandidate("a", "global::hot", 0.5)];
  const out = await s.boost(cands, { clusterBoostEnabled: true, clusterBoostTheta: { default: 0.08 } });
  assert.equal(out[0].score, 0.5, "score unchanged when provider throws");
});

await run("no parent_topic_id -> skipped", async () => {
  const s = new ClusterBoostStrategy(hotProvider, 0.08);
  const cands = [mkCandidate("a", null, 0.5)];
  const out = await s.boost(cands, { clusterBoostEnabled: true, clusterBoostTheta: { default: 0.08 } });
  assert.equal(out[0].score, 0.5, "score unchanged without topic id");
});

let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n    " + msg); }
}
console.log(`\nCLUSTER-BOOST-STRATEGY: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
