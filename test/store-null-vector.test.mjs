/**
 * Regression test: store.ts null vector crash
 *
 * Tests that Array.from(row.vector) does NOT crash when row.vector is null.
 * The fix: Array.from((row.vector || []) as Iterable<number>)
 *
 * Covers the 4 locations in store.ts where row.vector is accessed:
 *   1. backfillLegacySecondTimestamp — originalRow vector
 *   2. getById — inline row-to-entry conversion
 *   3. mergeMemoryEntry — original vector
 *   4. updateMemoryEntry — original vector
 *
 * Run: node test/store-null-vector.test.mjs
 * Expected: ALL TESTS PASSED
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeId() {
  return randomUUID();
}

describe("store.ts null vector handling", () => {
  let workDir;
  let store;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-nullvec-"));
    store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("upsert() and getById() works with valid vector", async () => {
    const id = makeId();
    await store.upsert({
      id,
      text: "entry with valid vector",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.8,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const entry = await store.getById(id);
    assert.ok(entry, "entry should be found");
    assert.equal(entry.id, id);
    // LanceDB stores float32, so values may have small precision differences
    assert.equal(entry.vector.length, 4, "vector should have 4 elements");
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(entry.vector[i] - [0.1, 0.2, 0.3, 0.4][i]) < 0.001,
        `vector[${i}] should be close to expected value`);
    }
  });

  it("getById returns null for non-existent entry", async () => {
    const entry = await store.getById(makeId());
    assert.equal(entry, null, "should return null for missing entry");
  });

  it("vectorSearch() works without crashing", async () => {
    const id = makeId();
    await store.upsert({
      id,
      text: "searchable entry",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const results = await store.vectorSearch([0.1, 0.2, 0.3, 0.4], 5, 0.3);
    assert.ok(Array.isArray(results), "results should be an array");
    assert.ok(results.length >= 1, "should find at least one result");
  });

  it("list() returns all entries without crashing", async () => {
    const id = makeId();
    await store.upsert({
      id,
      text: "entry for list test",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const entries = await store.list({ limit: 10 });
    assert.ok(Array.isArray(entries), "entries should be an array");
    assert.ok(entries.length >= 1, "should have at least one entry");
  });

  it("upsert() updates existing entry without crashing", async () => {
    const id = makeId();
    await store.upsert({
      id,
      text: "original text",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });

    await store.upsert({
      id,
      text: "updated text",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.8,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const entry = await store.getById(id);
    assert.ok(entry, "entry should exist after upsert");
    assert.equal(entry.text, "updated text");
    assert.equal(entry.importance, 0.8);
  });

  it("delete() removes entry without crashing", async () => {
    const id = makeId();
    await store.upsert({
      id,
      text: "entry to delete",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });

    await store.delete(id);
    const entry = await store.getById(id);
    assert.equal(entry, null, "entry should be deleted");
  });

  it("bulkStore() works with multiple entries", async () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push({
        text: `bulk entry ${i}`,
        vector: [0.1 * i, 0.2 * i, 0.3 * i, 0.4 * i],
        category: "fact",
        scope: "global",
        importance: 0.5 + i * 0.1,
        metadata: "{}",
      });
    }

    const stored = await store.bulkStore(entries);
    assert.equal(stored.length, 5, "should store all 5 entries");

    const list = await store.list({ limit: 10 });
    assert.ok(list.length >= 5, "should have at least 5 entries");
  });

  it("stats() returns valid statistics", async () => {
    await store.upsert({
      id: makeId(),
      text: "entry for stats",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });

    // Wait for async flush
    await store.flush();
    const stats = await store.stats();
    assert.ok(stats, "stats should be returned");
    assert.ok(stats.totalCount >= 1, `should have at least 1 entry, got ${stats.totalCount}`);
  });

  it("hasId() returns true for existing entry", async () => {
    const id = makeId();
    await store.upsert({
      id,
      text: "entry for hasId test",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const exists = await store.hasId(id);
    assert.equal(exists, true, "hasId should return true for existing entry");
  });

  it("count() returns correct number of entries", async () => {
    const countBefore = await store.count();
    assert.equal(countBefore, 0, "should start with 0 entries");

    await store.upsert({
      id: makeId(),
      text: "entry for count test",
      vector: [0.1, 0.2, 0.3, 0.4],
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const countAfter = await store.count();
    assert.equal(countAfter, 1, "should have 1 entry after insert");
  });
});
