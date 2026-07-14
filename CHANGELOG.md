## 1.1.0-beta.11 (OpenClaw 2026.5 runtime compatibility)

- Ship compiled `dist/index.js` runtime and point package/OpenClaw extension entries at it.
- Declare `contracts.tools` for registered agent tools.
- Avoid double-resolving already-absolute backup/admission audit paths.
- Load LanceDB via ESM dynamic `import()` instead of `require()`.

# Changelog

## Unreleased

### Fork (Dimon70007/memory-lancedb-pro, branch `fork-timeoutms`) — custom changes

Divergence point from upstream (`CortexReach/memory-lancedb-pro`): `2f2be72`.
These are the changes carried by this local fork. See `FORK.md` for the full
fork policy and restore procedure.

- **fix (timeoutms): portable session file path** — `src/reflection-store.ts`
  now builds the kludgey-file-index session path from `${homedir()}/.openclaw/...`
  instead of a hardcoded `/home/clawbox/.openclaw/...`, so the plugin works on
  any host/user. (commit `f308f19`)
- **feat (T048-11): `memory_feedback` tool** — explicit 👍/👎/neutral feedback
  channel for recalled candidates, feeding the calibration loop
  (`cluster_boost`, importance, `used_in_answer`). Registered in
  `registerAllMemoryTools`. (`src/tools.ts`)
- **feat (T048-HOST): recall-log `sessionKey` correlation** — `RetrievalContext`
  gains `sessionKey`; the recall-log sink now correlates tracked candidates with
  the post-hoc `used_in_answer` hook (`context.sessionKey ?? context.source ??
  "global"`). (`src/retriever.ts`)
- **feat (T048): production host-wiring** — `buildMemoryRetriever()` in `index.ts`
  injects `LanceDbRecallLogSink`, `TopicClusterProvider` (lazy resolvers reading
  live store tables) and `ClusterBoostStrategy` behind the `ScoreBoost`
  abstraction; handles `[DREAMING]` system events for the
  `memory-lancedb-pro-dreaming` cron. New modules: `src/cluster-boost.ts`,
  `src/recallLogSink.ts`, `src/topic-clusters.ts`, `src/calibration.ts`.
- **chore: line-ending normalization** — `src/reflection-store.ts` and
  `index.ts` normalized CRLF→LF; added `.gitattributes` (`* text=auto eol=lf`)
  to prevent future whole-file line-ending churn on upstream merges.
- **chore: config schema** — `openclaw.plugin.json` gains `clusterBoostEnabled`
  (default `false`) and `clusterBoostTheta` (per-scope θ weights) for the T048
  cluster-boost feature.
- **test/scripts**: `test/t048-prod-wiring.mjs` wired into the `test` script;
  added calibration/cluster-boost/recall-log/topic-cluster test suites and
  `scripts/gen-synthetic-recalllog.mjs`, `scripts/run-calibration.mjs`.

---

### Fix: cumulative turn counting for auto-capture smart extraction (#417, PR #549)

**Bug**: With `extractMinMessages: 2` + `smartExtraction: true`, single-turn DM conversations always fell through to regex fallback, writing dirty data (`l0_abstract == text`, no LLM distillation).

**Root causes**:
- `autoCaptureSeenTextCount` was overwritten per-event (always 1 for DM), never accumulating
- `buildAutoCaptureConversationKeyFromIngress` returned `null` for DM (no `conversationId`), so `pendingIngressTexts` was never written

**Changes**:
- **Cumulative counting**: `autoCaptureSeenTextCount` now accumulates across events instead of overwriting per-event
- **DM key fallback**: `buildAutoCaptureConversationKeyFromIngress` falls back to `channelId` when `conversationId` is falsy, so DM sessions now correctly write to `pendingIngressTexts` and match the key extracted by `buildAutoCaptureConversationKeyFromSessionKey`
- **Smart extraction threshold**: now uses cumulative turn count (`currentCumulativeCount`) instead of per-event message count
- **MAX_MESSAGE_LENGTH guard**: 5000 char limit per message in `pendingIngressTexts` rolling window prevents OOM from malformed input
- **Test**: added `runCumulativeTurnCountingScenario` in `test/smart-extractor-branches.mjs` verifying turn-1 skip and turn-2 trigger with `extractMinMessages=2`

**⚠️ Breaking change**: `extractMinMessages` semantics changed from "per-event message count" to "cumulative conversation turns". Before: each `agent_end` needed ≥N messages. After: smart extraction triggers at conversation turn N. This is a bug fix since the old semantics were structurally broken for DM; users relying on the old behavior may need to adjust their `extractMinMessages` values.

---

### T048-9: SOLID cluster_boost refactor + topic_clusters schema fix (production)

**Bug (root cause of inert cluster_boost)**: `TopicClusters.buildRow` emitted 4 fields (`hit_rate`, `recent_hits`, `avg_answer_gain`, `importance_mean`) that were missing from the `topic_clusters` table schema created by `openOrCreateTopicClustersTable`. Every `upsertTopic` threw `Found field not in schema`, swallowed by `trackTopics`' catch → `topic_clusters` stayed empty → `cluster_boost` inert (weight 0). Also `trackTopics` found no `topic`/`subtopic` in entry metadata → no topic derived.

**Changes**:
- SOLID refactor: extracted `ClusterBoostStrategy` (`src/cluster-boost.ts`) behind `ScoreBoost` interface; injected into retriever via `createRetriever({ options.scoreBoost })` (SRP/OCP/DIP); `TopicClusterProvider`/`RecallLogSink` kept narrow (ISP).
- Schema fix: added the 4 missing columns to the `topic_clusters` creation sample; dropped+recreated the (empty) table so it picks up the full schema.
- `trackTopics` fallback: topic = `meta.topic` || `meta.subtopic` || `entry.category` so the table populates from existing memories.
- Verified live: store → `topic_clusters` gains a row (`agent:main::other`, active_weight=0.5 cold-start, avg_importance=0.7).

**Production decisions (2026-07-09, user Q&A)**:
- `clusterBoostEnabled: true` stays ON in prod (improve in use, don't polish forever).
- Launch with DRY-RUN calibration weights (θ=0.04, a=0.3, b=0.2, c=0.1, d=0.05); calibrate on real `recall_log` later.
- Wire post-hoc `used_in_answer` hook (currently dead → `recall_log.used_in_answer=0`) + add explicit 👍/👎 feedback channel; source facts/decisions from session summary via `memory-compaction-redistill`.
- Recency wins on conflict (new > old, non-safety); guard: new info must not contradict `soul`/`system_prompt` (anti-injection).
- Fix `memory-lancedb-pro-dreaming` cron (skipped/disabled) so complementary new+old facts consolidate during dreaming.
- Backfill `topic_clusters` from 479 existing memories.

---

## 1.1.0-beta.2 (Smart Memory Beta + Access Reinforcement)

This is a **beta** release published under the npm dist-tag **`beta`** (it does not affect the stable `latest` channel).

Highlights:
- **Smart Extraction (LLM-powered)**: 6-category extraction with L0/L1/L2 metadata (falls back to regex capture when disabled or init fails)
- **Lifecycle scoring integrated into retrieval**: decay-based score adjustment + tier floors
- **Tier transitions (best-effort)**: bounded metadata write-backs for top results (tier / access stats)
- **Access reinforcement for time decay**: frequently *manually recalled* memories decay more slowly (spaced-repetition style)
  - Adds `AccessTracker` with debounced metadata write-back (accessCount / lastAccessedAt)
  - Adds retrieval config: `reinforcementFactor` (default: 0.5) and `maxHalfLifeMultiplier` (default: 3)

Notes:
- Access reinforcement is gated to manual recall (`source: \"manual\"`) to avoid auto-recall strengthening noise.

---

## 1.1.0-beta.1 (Smart Memory Beta)

- Initial beta with Smart Extraction + lifecycle components (decay engine + tier manager)

---

## 1.0.26

**Access Reinforcement for Time Decay**

- **Feat**: Access reinforcement — frequently *manually recalled* memories decay more slowly (spaced-repetition style)
- **New**: `AccessTracker` with debounced metadata write-back (records accessCount / lastAccessedAt)
- **New**: Config options under `retrieval`: `reinforcementFactor` (default: 0.5) and `maxHalfLifeMultiplier` (default: 3)
- **New**: `MemoryStore.getById()` pure-read helper for efficient metadata lookup

PR: #37

Breaking changes: None. Backward compatible (set `reinforcementFactor: 0` to disable).

---


## 1.0.22

**Storage Path Validation & Better Error Messages**

- **Fix**: Validate `dbPath` at startup — resolve symlinks, auto-create missing directories, check write permissions (#26, #27)
- **Fix**: Write/connection failures now include `errno`, resolved path, and actionable fix suggestions instead of generic errors (#28)
- **New**: Exported `validateStoragePath()` utility for external tooling and diagnostics

Breaking changes: None. Backward compatible.

---

## 1.0.21

**Long Context Chunking**

- **Feats**: Added automatic chunking for documents exceeding embedding context limits
- **Feats**: Smart semantic-aware chunking at sentence boundaries with configurable overlap
- **Feats**: Chunking adapts to different embedding model context limits (Jina, OpenAI, Gemini, etc.)
- **Feats**: Parallel chunk embedding with averaged result for better semantic preservation
- **Fixes**: Handles "Input length exceeds context length" errors gracefully
- **Docs**: Added comprehensive documentation in docs/long-context-chunking.md

Breaking changes: None. Backward compatible with existing configurations.

---

## 1.0.20

- Fix: reduce auto-capture noise by skipping memory-management prompts (delete/forget/cleanup memory entries).
- Improve: broaden English decision triggers so statements like "we decided / going forward we will use" are captured as decisions.

## 1.0.19

- UX: show memory IDs in `memory-pro list` and `memory-pro search` output, so users can delete entries without switching to JSON.
- UX: include IDs in agent tool outputs (`memory_recall`, `memory_list`) for easier debugging and `memory_forget` follow-ups.

## 1.0.18

- Fix: sync `openclaw.plugin.json` version with `package.json`, so the OpenClaw plugin info shows the correct version.

## 1.0.17

- Fix: adaptive-retrieval now strips OpenClaw-injected timestamp prefixes like `[Mon YYYY-MM-DD HH:MM ...] ...` to avoid skewing length-based heuristics.
- Improve: expanded SKIP/FORCE keyword patterns with Traditional Chinese variants.

## 1.0.16

- Feat: expand memory capture triggers to support Traditional Chinese (繁體中文) in addition to Simplified Chinese, and improve category detection keywords.

## 1.0.15

- Docs: add troubleshooting note for LanceDB/Arrow returning `BigInt` numeric columns, and confirm the plugin coerces numeric fields via `Number(...)` for compatibility.

## 1.0.14

- Fix: coerce LanceDB/Arrow numeric columns that may arrive as `BigInt` (`timestamp`, `importance`, `_distance`, `_score`) into `Number(...)` to avoid runtime errors like "Cannot mix BigInt and other types" on LanceDB 0.26+.

## 1.0.13

- Fix: Force `encoding_format: "float"` for OpenAI-compatible embedding requests to avoid base64/float ambiguity and dimension mismatch issues with some providers/gateways.
- Feat: Add Voyage AI (`voyage`) as a supported rerank provider, using `top_k` and `Authorization: Bearer` header.
- Refactor: Harden rerank response parser to accept both `results[]`/`data[]` payload shapes and `relevance_score`/`score` field names across all providers.

## 1.0.12

- Fix: ghost memories stuck in autoRecall after deletion (#15). BM25-only results from stale FTS index are now validated via `store.hasId()` before inclusion in fused results. Removed the BM25-only floor score of 0.5 that allowed deleted entries to survive `hardMinScore` filtering.
- Fix: HEARTBEAT pattern now matches anywhere in the prompt (not just at start), preventing autoRecall from triggering on prefixed HEARTBEAT messages.
- Add: `autoRecallMinLength` config option to set a custom minimum prompt length for autoRecall (default: 15 chars English, 6 CJK). Prompts shorter than this threshold are skipped.
- Add: `ping`, `pong`, `test`, `debug` added to skip patterns in adaptive retrieval.

## 1.0.11

- Change: set `autoRecall` default to `false` to avoid the model echoing injected `<relevant-memories>` blocks.

## 1.0.10

- Fix: avoid blocking OpenClaw gateway startup on external network calls by running startup self-checks in the background with timeouts.

## 1.0.9

- Change: update default `retrieval.rerankModel` to `jina-reranker-v3` (still fully configurable).

## 1.0.8

- Add: JSONL distill extractor supports optional agent allowlist via env var `OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS` (default off / compatible).

## 1.0.7

- Fix: resolve `agentId` from hook context (`ctx?.agentId`) for `before_agent_start` and `agent_end`, restoring per-agent scope isolation when using multi-agent setups.

## 1.0.6

- Fix: auto-recall injection now correctly skips cron prompts wrapped as `[cron:...] run ...` (reduces token usage for cron jobs).
- Fix: JSONL distill extractor filters more transcript/system noise (BOOT.md, HEARTBEAT, CLAUDE_CODE_DONE, queued blocks) to avoid polluting distillation batches.

## 1.0.5

- Add: optional JSONL session distillation workflow (incremental cursor + batch format) via `scripts/jsonl_distill.py`.
- Docs: document the JSONL distiller setup in README (EN) and README_CN (ZH).

## 1.0.4

- Fix: `embedding.dimensions` is now parsed robustly (number / numeric string / env-var string), so it properly overrides hardcoded model dims (fixes Ollama `nomic-embed-text` dimension mismatch).

## 1.0.3

- Fix: `memory-pro reembed` no longer crashes (missing `clampInt` helper).

## 1.0.2

- Fix: pass through `embedding.dimensions` to the OpenAI-compatible `/embeddings` request payload when explicitly configured.
- Chore: unify plugin version fields (`openclaw.plugin.json` now matches `package.json`).

## 1.0.1

- Fix: CLI command namespace updated to `memory-pro`.

## 1.0.0

- Initial npm release.
