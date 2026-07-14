import jitiFactory from "jiti";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

const wd = mkdtempSync(path.join(tmpdir(), "debug-"));
const store = new MemoryStore({ dbPath: path.join(wd, "db"), vectorDim: 4 });
await store.store({
  text: "seed", vector: [1,0,0,0], category: "fact",
  scope: "global", importance: 0.5, metadata: "{}",
});

// Check what was stored
const stats = await store.listStats();
console.log("listStats:", JSON.stringify(stats, null, 2));

// Check recall_log table
const table = store.getRecallLogTable();
const rows = await table.query().toArray();
console.log("recall_log rows:", rows.length);

rmSync(wd, { recursive: true, force: true });
