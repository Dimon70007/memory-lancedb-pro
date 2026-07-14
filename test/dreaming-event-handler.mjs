// T048-12 regression: the [DREAMING] system-event handler in index.ts.
//
// OpenClaw has no dedicated system_event plugin hook; the
// memory-lancedb-pro-dreaming cron emits a systemEvent whose text contains
// "[DREAMING]", delivered to the session and surfaced via message_received.
// The plugin must have a message_received handler that (a) filters on the
// "[DREAMING]" marker and (b) triggers runDreamingSweep().
//
// A full behavioral test would require registering the whole plugin with a
// live store/config (the sweep itself is covered by dreaming-engine.test.mjs).
// This test guards the HOST WIRING at source level so the handler can't be
// silently dropped, mirroring test/t048-prod-wiring.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");

const results = [];
function run(name, fn) {
  try { fn(); results.push([true, name, ""]); }
  catch (e) { results.push([false, name, String((e && e.stack) || e)]); }
}

run("registers a message_received handler", () => {
  assert.match(src, /api\.on\(\s*["']message_received["']/, "must register message_received");
});

run("filters on the [DREAMING] marker", () => {
  assert.ok(
    src.includes('includes("[DREAMING]")') || src.includes("includes('[DREAMING]')"),
    "handler must gate on the [DREAMING] marker",
  );
});

run("triggers runDreamingSweep() from the handler", () => {
  // The marker check and the sweep call must both be present and the sweep
  // must be defined somewhere in the module.
  assert.match(src, /runDreamingSweep\(\)/, "must call runDreamingSweep()");
  assert.match(src, /function runDreamingSweep\b|runDreamingSweep\s*=/, "runDreamingSweep must be defined");
});

run("[DREAMING] branch calls the sweep near its marker check", () => {
  const idx = src.indexOf('includes("[DREAMING]")');
  assert.ok(idx > -1, "marker check present");
  const window = src.slice(idx, idx + 600);
  assert.match(window, /runDreamingSweep\(\)/, "sweep call must follow the [DREAMING] marker check");
});

run("sweep failure is non-fatal (guarded)", () => {
  const idx = src.indexOf('includes("[DREAMING]")');
  const window = src.slice(idx, idx + 600);
  assert.match(window, /\.catch\(/, "sweep must be fire-and-forget with a .catch guard");
});

let pass = 0, fail = 0;
for (const [ok, name, msg] of results) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}: ${msg}`); }
}
console.log(`\n${pass}/${pass + fail} [DREAMING] event handler tests passed`);
if (fail > 0) process.exit(1);
