// T048-5 enabler: a drop-in RecallLogSink that persists RecallLogEntry rows to
// the `recall_log` LanceDB table. The host wires it via:
//
//   const sink = new LanceDbRecallLogSink(store.getRecallLogTable());
//   const retriever = createRetriever({ /* ... */ }, { recallLogSink: sink });
//
// The retriever already swallows sink errors (`.catch(() => undefined)`), so a
// failing write never breaks retrieval. `logBatch` is intentionally thin: it
// delegates to `table.add`, which accepts the nullable topic_id / user_feedback
// columns (verified by test/recall-log-table-creation.mjs).
import type * as LanceDB from "@lancedb/lancedb";
import type { RecallLogEntry, RecallLogSink } from "./retriever.js";

export class LanceDbRecallLogSink implements RecallLogSink {
  constructor(private readonly table: LanceDB.Table) {}

  async logBatch(entries: RecallLogEntry[]): Promise<void> {
    if (!entries.length) return;
    await this.table.add(entries as unknown as Record<string, unknown>[]);
  }
}
