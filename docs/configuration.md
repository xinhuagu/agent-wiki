# Configuration

## `.agent-wiki.yaml`

```yaml
version: "2"

# Wiki data paths (optional — defaults shown)
wiki:
  workspace: ./data               # separate data directory
  path: "wiki/"                   # wiki pages directory name
  raw_path: "raw/"                # raw sources directory name
  schemas_path: "schemas/"        # entity templates directory name

# Lint settings (optional — defaults shown)
lint:
  check_orphans: true
  check_stale_days: 30
  check_missing_sources: true
  check_contradictions: true
  check_integrity: true

# Hybrid BM25+vector search (optional — off by default)
search:
  hybrid: false                   # set to true to enable semantic re-ranking
  model: "Xenova/all-MiniLM-L6-v2"  # sentence-transformer model (~90 MB)
  bm25_weight: 0.5                # BM25 score weight in final blend (0–1)
  vector_weight: 0.5              # cosine similarity weight in final blend (0–1)

# Atlassian integration (optional)
atlassian:
  allowed_hosts:
    - your-company.atlassian.net
  max_pages: 100                  # Confluence recursion limit
  max_attachment_size: 10485760   # 10 MB max per Jira attachment

# Security (optional)
security:
  allowed_source_dirs:            # restrict raw_add source_path
    - /home/user/documents        # absolute path
    - ../shared-data              # relative to config root
```

## Environment Variables

### Atlassian

```bash
export CONFLUENCE_API_TOKEN="email@company.com:your-api-token"
export JIRA_API_TOKEN="email@company.com:your-api-token"
```

### Workspace

```bash
export AGENT_WIKI_WORKSPACE="/path/to/data"
```

Resolution priority: CLI `--workspace` > `AGENT_WIKI_WORKSPACE` env > config file > config root.

## Workspace Separation

Code and data live in separate directories. The tool is stateless — all state lives in the workspace:

```
npx @agent-wiki/mcp-server serve --wiki-path ./config --workspace ./data
```

This creates:

```
./data/
  wiki/     # compiled knowledge pages
  raw/      # immutable source documents
  schemas/  # entity type templates
```

## Security

- **Directory traversal protection** — all user-supplied page/filename paths go through `safePath()`, which rejects `../`, absolute paths, and null bytes
- **Source path restriction** — `raw_add` with `source_path` is restricted to workspace directory by default; configurable via `security.allowed_source_dirs`
- **Atlassian host allowlist** — `atlassian.allowed_hosts` prevents SSRF; requests to non-listed hosts are rejected
- **No secrets in code** — auth tokens are read from environment variables only

## CLI Reference

```bash
# MCP Server
agent-wiki serve                              # start MCP server (stdio)
agent-wiki serve --workspace ./data           # separate data directory

# Knowledge base management
agent-wiki init ./my-kb                       # initialize new knowledge base
agent-wiki search "yolo"                      # search wiki
agent-wiki list                               # list all pages
agent-wiki list --type concept                # filter by type
agent-wiki raw-list                           # list raw sources
agent-wiki raw-verify                         # verify raw file integrity
agent-wiki lint                               # run health checks

# Direct tool call (all 18 tools)
agent-wiki call wiki_search '{"query":"yolo"}'
agent-wiki call raw_add '{"filename":"doc.pdf","source_path":"/path/to/file"}'
agent-wiki call code_parse '{"path":"PAYROLL.cbl"}'
agent-wiki call wiki_list                     # no args needed

# Skill installation
agent-wiki install aceclaw                    # install as AceClaw skill
agent-wiki install aceclaw --wiki-path ./kb   # with custom wiki path
agent-wiki install claude-code                # install as Claude Code plugin

# JSON output (all subcommands)
agent-wiki list --json                        # structured JSON output
agent-wiki search "yolo" --json
agent-wiki lint --json
```

### `call` command

The `call` command provides direct access to all 18 MCP tools without running the server. Arguments are passed as a JSON string:

```bash
agent-wiki call <tool_name> '<json_args>' [-w <wiki-path>] [--workspace <path>]
```

This is the primary interface used by Claude Code and AceClaw skills.

### `install` command

One-command installation as a native skill for supported agent harnesses:

| Target | What it does |
|--------|-------------|
| `aceclaw` | Copies SKILL.md to `~/.aceclaw/skills/agent-wiki/`, adds MCP server to `~/.aceclaw/mcp-servers.json` |
| `claude-code` | Copies plugin to `~/.claude/plugins/agent-wiki/` (load with `claude --plugin-dir ~/.claude/plugins/agent-wiki`) |
