# FORK.md — memory-lancedb-pro (custom fork)

This repository is a **customized fork** of upstream `memory-lancedb-pro`
(CortexReach). For day-to-day OpenClaw use in this project, load it **by path**
from the agent workspace `skills/` directory — see
**[INSTALL_SKILLS.md](INSTALL_SKILLS.md)**.

Managed installs (`openclaw plugins install git:…` → `~/.openclaw/git/…`) work,
but break sibling relative paths used by companion plugins; prefer path-load.

## Remotes

| Name | URL | Role |
|------|-----|------|
| `github` (optional) | `https://github.com/CortexReach/memory-lancedb-pro.git` | Upstream (read) |
| `origin` | `git@github.com:Dimon70007/memory-lancedb-pro.git` | This fork |

Working branch for path-load installs: **`fork-timeoutms-fixed`**.

## Custom changes (summary)

See `CHANGELOG.md` for the versioned list. High level:

1. Session / timeout path fixes via portable home resolution.
2. Recall-log / feedback / topic-cluster boost wiring.
3. Config schema knobs for cluster boost.
4. LF line endings (`.gitattributes`).

## Maintenance

- After source changes: `npm run build` before commit or deploy to `skills/`.
- Document new fork behavior in `CHANGELOG.md`.
- Do not put secrets, LAN IPs, or host account paths into docs — use
  placeholders and `${ENV_VAR}` references only.
