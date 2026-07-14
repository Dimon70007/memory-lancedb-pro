# FORK.md — memory-lancedb-pro (custom fork)

This directory is a **customized fork** of the upstream plugin
`memory-lancedb-pro`. It is loaded by OpenClaw **by path**
(`plugins.load.paths: ["/home/clawbox/workspace/skills"]`), not from
`node_modules`, so a plain `npm install` in OpenClaw does not overwrite it.
This file documents what the fork changes, why, and how to restore it so the
custom work is never lost on a reinstall/reset.

## Remotes

| Name | URL | Role |
|------|-----|------|
| `github` | `https://github.com/CortexReach/memory-lancedb-pro.git` | Upstream (read) |
| `origin` | `git@github.com:Dimon70007/memory-lancedb-pro.git` | Personal fork |

Working branch: **`fork-timeoutms`**.
Fork/divergence point from upstream: **`2f2be72`**.

> Access note: this environment has **read-only** access to `origin`. All fork
> maintenance here is **local only** — no pushes are made to GitHub from the
> agent. Publishing to GitHub is done by the repository owner (Dmitriy).

## Custom changes carried by this fork

See `CHANGELOG.md` → "Fork (Dimon70007…) — custom changes" for the detailed,
versioned list. Summary:

1. **timeoutms fix** — portable session file path via `homedir()`
   (`src/reflection-store.ts`).
2. **T048-11** — `memory_feedback` tool (explicit 👍/👎 feedback → calibration).
3. **T048-HOST** — recall-log `sessionKey` correlation (`src/retriever.ts`).
4. **T048** — production host-wiring in `index.ts` (`buildMemoryRetriever`:
   recall-log sink + topic-cluster provider + cluster-boost strategy;
   `[DREAMING]` event handling). New modules: `cluster-boost`, `recallLogSink`,
   `topic-clusters`, `calibration`.
5. **line-ending normalization** — CRLF→LF + `.gitattributes` (`eol=lf`).
6. **config schema** — `clusterBoostEnabled` / `clusterBoostTheta` in
   `openclaw.plugin.json`.

## Local backups (off-repo safety net)

Stored in `/home/clawbox/workspace/patches/`:

- `memory-lancedb-pro-fork-2026-07-14.bundle` — self-contained clone of the
  fork branch (restore without GitHub).
- `memory-lancedb-pro-custom-2026-07-14.patch` + `0001…0006-*.format.patch` —
  full patch series from the fork point.
- `fork-delta/` + `fork-delta-combined-2026-07-14.patch` — delta of changes not
  yet present on the GitHub fork branch.
- `RESTORE-memory-lancedb-pro.md` — step-by-step restore instructions.

## Maintenance rules

- **Never** push to `origin`/`github` from the agent (read-only; owner publishes).
- Keep source (`src/*.ts`, `index.ts`) and built `dist/*.js` in sync — after any
  source change run `npm run build` before committing.
- Any new custom change → add a bullet under the fork section in `CHANGELOG.md`
  **and** refresh the bundle/patches in `patches/` so the off-repo backup stays
  current.
- Preserve LF endings; do not reintroduce CRLF (guarded by `.gitattributes`).

## Restore (quick)

```bash
# From the local bundle (no internet needed):
rm -rf /home/clawbox/workspace/skills/memory-lancedb-pro
git clone /home/clawbox/workspace/patches/memory-lancedb-pro-fork-2026-07-14.bundle \
          /home/clawbox/workspace/skills/memory-lancedb-pro
cd /home/clawbox/workspace/skills/memory-lancedb-pro
git checkout fork-timeoutms
```

Full options (GitHub / patch series / single diff) are in
`patches/RESTORE-memory-lancedb-pro.md`.
