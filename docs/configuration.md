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
npx @agent-wiki/mcp-server serve                     # start MCP server (stdio)
npx @agent-wiki/mcp-server serve --workspace ./data   # separate data directory
npx @agent-wiki/mcp-server init ./my-kb               # initialize new knowledge base
npx @agent-wiki/mcp-server search "yolo"              # search wiki
npx @agent-wiki/mcp-server list                       # list all pages
npx @agent-wiki/mcp-server list --type concept        # filter by type
npx @agent-wiki/mcp-server raw-list                   # list raw sources
npx @agent-wiki/mcp-server raw-verify                 # verify raw file integrity
npx @agent-wiki/mcp-server lint                       # run health checks
```
