# Shared MCP Server

The MCP server is implemented at [`agent/src/mcp/server.ts`](../agent/src/mcp/server.ts) (co-located
with the agent package so it shares its TypeScript config, types, and dependencies — a build
simplification over a standalone package; the architecture in design §2 is unchanged).

It exposes the system's tools over **stdio** so Claude Code (scheduled/unattended) and Claude Desktop
(interactive review) drive the **same** `data/jobs.db` with identical behavior.

## Tools

| Tool | Purpose |
|---|---|
| `search_jobs` | Run sourcing (connectors → H-1B pre-filter → dedup-insert). |
| `score_fit` | Score a job (or all unapplied) against the profile. |
| `tailor_application` | ATS resume + screening answers (flags unanswerable; no fabrication). |
| `fill_form` | Guarded apply engine: fill → screenshot → (dryrun stops / live submits). |
| `track` | Query/update tracker; ingest AIApply/Jobright CSVs. |
| `report` | Build + return the dated markdown report. |
| `halt` / `resume` | Kill switch (write/remove `data/STOP`). |

## Launch

```bash
cd agent && npm run mcp        # = tsx src/mcp/server.ts (stdio)
```

## Register with a client

Claude Desktop (`claude_desktop_config.json`) / Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "job-apply": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "c:/Users/velpu/OneDrive/Desktop/ML/ai-job-search/agent",
      "env": { "APPLY_MODE": "dryrun" }
    }
  }
}
```

Override guardrails via `env` (e.g. `APPLY_MODE`, `FIT_THRESHOLD`, `DAILY_CAP`). Default stays
`dryrun` — the server never submits unless explicitly switched to `live`.
