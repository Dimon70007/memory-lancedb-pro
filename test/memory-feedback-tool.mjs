// T048-11: memory_feedback tool.
// Verifies the tool wrapper around MemoryStore.recordFeedback:
//   - registers under name "memory_feedback"
//   - normalizes feedback to sign (-1 | 0 | +1)
//   - forwards (candidateId, sign) to store.recordFeedback
//   - validates candidateId (missing -> error, no store call)
//   - is non-fatal when store.recordFeedback throws

import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerMemoryFeedbackTool } = jiti("../src/tools.ts");

function makeTool(context) {
  let factory = null;
  const api = {
    registerTool(f, meta) {
      assert.equal(meta.name, "memory_feedback", "tool registers under memory_feedback");
      factory = f;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerMemoryFeedbackTool(api, context);
  assert.ok(factory, "registerMemoryFeedbackTool must call api.registerTool");
  return factory({});
}

async function exec(tool, params) {
  return tool.execute("call-1", params, undefined, () => {}, {});
}

const results = [];
async function run(name, fn) {
  try { await fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String((e && e.stack) || e)]); }
}

await run("registers as memory_feedback with expected params", async () => {
  const tool = makeTool({ store: { async recordFeedback() {} } });
  assert.equal(tool.name, "memory_feedback");
  assert.ok(tool.parameters, "has parameters schema");
});

await run("forwards positive feedback as +1", async () => {
  const calls = [];
  const tool = makeTool({ store: { async recordFeedback(id, fb) { calls.push([id, fb]); } } });
  const res = await exec(tool, { candidateId: "cand-1", feedback: 1 });
  assert.deepEqual(calls, [["cand-1", 1]]);
  assert.match(res.content[0].text, /recorded/i);
});

await run("normalizes any positive value to +1 (Math.sign)", async () => {
  const calls = [];
  const tool = makeTool({ store: { async recordFeedback(id, fb) { calls.push(fb); } } });
  await exec(tool, { candidateId: "c", feedback: 5 });
  await exec(tool, { candidateId: "c", feedback: 0.3 });
  assert.deepEqual(calls, [1, 1], "5 and 0.3 should both map to +1");
});

await run("normalizes negative value to -1", async () => {
  const calls = [];
  const tool = makeTool({ store: { async recordFeedback(id, fb) { calls.push(fb); } } });
  await exec(tool, { candidateId: "c", feedback: -3 });
  assert.deepEqual(calls, [-1]);
});

await run("neutral feedback maps to 0", async () => {
  const calls = [];
  const tool = makeTool({ store: { async recordFeedback(id, fb) { calls.push(fb); } } });
  await exec(tool, { candidateId: "c", feedback: 0 });
  assert.deepEqual(calls, [0]);
});

await run("missing candidateId returns error and does not call store", async () => {
  let called = false;
  const tool = makeTool({ store: { async recordFeedback() { called = true; } } });
  const res = await exec(tool, { candidateId: "", feedback: 1 });
  assert.equal(called, false, "store.recordFeedback must not be called");
  assert.equal(res.details?.error, "missing_candidateId");
});

await run("is non-fatal when store.recordFeedback throws", async () => {
  const tool = makeTool({ store: { async recordFeedback() { throw new Error("db down"); } } });
  const res = await exec(tool, { candidateId: "c", feedback: 1 });
  assert.equal(res.details?.error, "feedback_failed");
  assert.match(res.content[0].text, /failed/i);
});

let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}: ${msg}`); }
}
console.log(`\n${pass}/${pass + fail} memory_feedback tool tests passed`);
if (fail > 0) process.exit(1);
