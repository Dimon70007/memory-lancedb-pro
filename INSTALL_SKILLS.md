# Install into workspace `skills/` (path-load)

This fork is intended to load from the **agent workspace `skills/` directory** via
`plugins.load.paths`, not from OpenClaw’s managed `~/.openclaw/git` / `extensions`
trees. That layout keeps sibling plugins (e.g. `memory-compaction-redistill`) on
relative paths and matches how this monorepo operates.

No API keys, hostnames, or account paths belong in this file — use env vars and
placeholders only.

## 1. Choose workspace

`WORKSPACE` is the OpenClaw agent workspace (the directory that contains
`skills/`). Examples: `$OPENCLAW_WORKSPACE`, or `$HOME/workspace`.

```bash
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/workspace}"
SKILLS="$WORKSPACE/skills"
mkdir -p "$SKILLS"
```

## 2. Remove a conflicting managed install (optional)

If you previously ran `openclaw plugins install git:…` / `npm:…` for this id:

```bash
openclaw plugins uninstall memory-lancedb-pro 2>/dev/null || true
```

## 3. Clone this fork into `skills/`

Branch is required (no silent default):

```bash
git clone --branch fork-timeoutms-fixed --single-branch \
  git@github.com:Dimon70007/memory-lancedb-pro.git \
  "$SKILLS/memory-lancedb-pro"

cd "$SKILLS/memory-lancedb-pro"
npm install
npm run build
```

Directory name must stay `memory-lancedb-pro` (plugin id).

## 4. Point OpenClaw at `skills/`

In the live OpenClaw config (`~/.openclaw/openclaw.json` or your deploy copy):

```json
{
  "plugins": {
    "load": {
      "paths": ["<workspace>/skills"]
    },
    "allow": ["memory-lancedb-pro"],
    "slots": {
      "memory": "memory-lancedb-pro"
    },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "dbPath": "<state-dir>/memory/lancedb_pro",
          "embedding": {
            "apiKey": "ollama",
            "model": "<embedding-model>",
            "baseURL": "http://127.0.0.1:11434/v1",
            "dimensions": 1024
          },
          "llm": {
            "auth": "api-key",
            "apiKey": "${LLM_API_KEY}",
            "baseURL": "<openai-compatible-base-url>",
            "model": "<llm-model-id>",
            "timeoutMs": 90000
          }
        }
      }
    }
  }
}
```

Replace `<workspace>`, `<state-dir>`, model ids, and base URL with your values.
Keep secrets in the gateway process environment (`${…}` placeholders only).

Optional link (records the path install without copying into managed roots):

```bash
openclaw plugins install -l "$SKILLS/memory-lancedb-pro"
```

## 5. Restart and verify

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
openclaw plugins doctor
```

Expect the plugin root under `$SKILLS/memory-lancedb-pro`, not under
`~/.openclaw/git/…`.

## Update later

```bash
cd "$SKILLS/memory-lancedb-pro"
git fetch origin
git checkout fork-timeoutms-fixed
git pull --ff-only
npm install
npm run build
openclaw gateway restart
```

## Related

- Fork notes: [FORK.md](FORK.md)
- Upstream / feature docs: [README.md](README.md)
