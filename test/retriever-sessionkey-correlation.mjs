// T048-HOST: recall-log session_key correlation in the retriever.
// Verifies the precedence context.sessionKey ?? context.source ?? "global"
// used both for RecallLogEntry.session_key and for store.trackCandidate(),
// so post-hoc used_in_answer can correlate candidates to the right session.

import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever } = jiti("../src/retriever.ts");

// Minimal fake store: only what the retriever needs for a vector recall +
// the T048-HOST tracking hook.
function makeStore() {
  const tracked = [];
  const entries = [
    { id: "m1", text: "alpha memory", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: JSON.stringify({ parent_topic_id: "global::a" }) },
    { id: "m2", text: "beta memory", vector: [1, 0], category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}" },
  ];
  return {
    tracked,
    async ensureInitialized() {},
    hasFtsSupport: false,
    async vectorSearch() {
      return entries.map((e) => ({ entry: e, score: 0.9, scoreRaw: 0.9, scoreFinal: 0.9, sources: { vector: { score: 0.9, rank: 1 } } }));
    },
    async search() {
      return entries.map((e) => ({ entry: e, score: 0.9, scoreRaw: 0.9, scoreFinal: 0.9, sources: { vector: { score: 0.9, rank: 1 } } }));
    },
    trackCandidate(sessionKey, candidateId, text) {
      tracked.push({ sessionKey, candidateId, text });
    },
    getRecallLogTable() { return null; },
    getTopicClusters() { return null; },
  };
}

const embedder = { async embedQuery() { return [1, 0]; }, async embedPassage() { return [1, 0]; } };

async function retrieveWith(context) {
  const store = makeStore();
  const logged = [];
  const recallLogSink = { async logBatch(entries) { logged.push(...entries); } };
  const retriever = createRetriever(store, embedder, { mode: "vector", dimensions: 2 }, { recallLogSink });
  await retriever.retrieve(context);
  // logBatch is fire-and-forget; give the microtask queue a tick to flush.
  await new Promise((r) => setTimeout(r, 0));
  return { store, logged };
}

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String((e && e.stack) || e)]); }
}

await run("explicit sessionKey wins", async () => {
  const { store, logged } = await retrieveWith({ query: "q", sessionKey: "sess-42", source: "auto-recall" });
  assert.ok(logged.length > 0, "should log recall entries");
  for (const e of logged) assert.equal(e.session_key, "sess-42");
  assert.ok(store.tracked.length > 0, "should track candidates");
  for (const t of store.tracked) assert.equal(t.sessionKey, "sess-42");
});

await run("falls back to source when sessionKey absent", async () => {
  const { store, logged } = await retrieveWith({ query: "q", source: "manual" });
  for (const e of logged) assert.equal(e.session_key, "manual");
  for (const t of store.tracked) assert.equal(t.sessionKey, "manual");
});

await run("falls back to 'global' when neither present", async () => {
  const { store, logged } = await retrieveWith({ query: "q" });
  for (const e of logged) assert.equal(e.session_key, "global");
  for (const t of store.tracked) assert.equal(t.sessionKey, "global");
});

await run("tracked candidateId/text match logged candidate_id", async () => {
  const { store, logged } = await retrieveWith({ query: "q", sessionKey: "s" });
  const loggedIds = new Set(logged.map((e) => e.candidate_id));
  const trackedIds = new Set(store.tracked.map((t) => t.candidateId));
  assert.deepEqual([...trackedIds].sort(), [...loggedIds].sort());
  const m1 = store.tracked.find((t) => t.candidateId === "m1");
  assert.equal(m1.text, "alpha memory");
});

let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}: ${msg}`); }
}
console.log(`\n${pass}/${pass + fail} retriever sessionKey correlation tests passed`);
if (fail > 0) process.exit(1);
