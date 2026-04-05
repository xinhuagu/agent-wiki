/**
 * Atlassian integration — Confluence and Jira importers.
 *
 * Fetches pages/issues via Atlassian Cloud REST APIs and saves them
 * as immutable raw documents with full metadata (.meta.yaml sidecars).
 *
 * Security:
 *   - Auth tokens read from environment variables (never passed as args)
 *   - Host allowlist prevents SSRF to arbitrary Atlassian instances
 *   - Page/attachment limits prevent runaway recursion
 *   - Slugified filenames prevent directory traversal from titles
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { VERSION } from "./version.js";

// ── Types ─────────────────────────────────────────────────────

export interface AtlassianConfig {
  allowedHosts: string[];
  maxPages: number;
  maxAttachmentSize: number; // bytes
}

export const ATLASSIAN_DEFAULTS: AtlassianConfig = {
  allowedHosts: [],
  maxPages: 100,
  maxAttachmentSize: 10 * 1024 * 1024, // 10 MB
};

export interface ConfluencePageNode {
  id: string;
  title: string;
  file: string;
  children: ConfluencePageNode[];
}

export interface ConfluenceImportResult {
  pages: number;
  tree: ConfluencePageNode;
  files: string[];
}

export interface JiraImportResult {
  issueKey: string;
  summary: string;
  files: string[];
  linkedIssues: string[];
  importedCount: number;
}

/** Metadata sidecar shape (matches RawDocument from wiki.ts). */
interface RawMeta {
  path: string;
  sourceUrl?: string;
  downloadedAt: string;
  sha256: string;
  size: number;
  mimeType?: string;
  description?: string;
  tags?: string[];
}

// ── Helpers ───────────────────────────────────────────────────

export function resolveAuth(authEnv: string): string {
  const value = process.env[authEnv];
  if (!value) {
    throw new Error(
      `Environment variable "${authEnv}" is not set. ` +
        `Set it to "email:api-token" for Atlassian Cloud authentication.`
    );
  }
  // If it looks like email:token, auto-encode as Basic auth
  if (
    value.includes(":") &&
    !value.startsWith("Basic ") &&
    !value.startsWith("Bearer ")
  ) {
    return `Basic ${Buffer.from(value).toString("base64")}`;
  }
  return value;
}

export function validateHost(host: string, allowed: string[]): void {
  if (allowed.length === 0) return; // no restriction configured
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error(
      `Host "${host}" is not in the allowed list: [${allowed.join(", ")}]. ` +
        `Configure atlassian.allowed_hosts in .agent-wiki.yaml.`
    );
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function hash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function writeMeta(filePath: string, meta: RawMeta): void {
  writeFileSync(filePath + ".meta.yaml", yaml.dump(meta, { lineWidth: 100 }));
}

// ═══════════════════════════════════════════════════════════════
//  CONFLUENCE
// ═══════════════════════════════════════════════════════════════

export function parseConfluenceUrl(
  url: string
): { host: string; pageId: string } {
  const match = url.match(/https?:\/\/([^/]+)\/wiki\/.*?pages\/(\d+)/);
  if (!match) {
    throw new Error(
      `Cannot parse Confluence URL: "${url}". ` +
        `Expected: https://company.atlassian.net/wiki/spaces/SPACE/pages/12345/...`
    );
  }
  return { host: match[1]!, pageId: match[2]! };
}

export async function confluenceImport(
  url: string,
  rawDir: string,
  config: AtlassianConfig,
  opts: {
    recursive?: boolean;
    depth?: number;
    authEnv?: string;
  } = {}
): Promise<ConfluenceImportResult> {
  const { host, pageId } = parseConfluenceUrl(url);
  validateHost(host, config.allowedHosts);

  const authHeader = resolveAuth(opts.authEnv ?? "CONFLUENCE_API_TOKEN");
  const maxDepth = opts.depth ?? (opts.recursive ? 50 : 0);
  const baseApi = `https://${host}/wiki/api/v2`;
  const files: string[] = [];
  let pageCount = 0;

  // ── API helpers ──

  async function api(endpoint: string): Promise<any> {
    const resp = await fetch(`${baseApi}${endpoint}`, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": `agent-wiki/${VERSION}`,
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Confluence API ${resp.status} ${resp.statusText} — ${endpoint}\n${body.slice(0, 500)}`
      );
    }
    return resp.json();
  }

  async function getPage(
    pid: string
  ): Promise<{ id: string; title: string; spaceId?: string; html: string }> {
    const data = await api(`/pages/${pid}?body-format=storage`);
    return {
      id: data.id,
      title: data.title,
      spaceId: data.spaceId,
      html: data.body?.storage?.value ?? "",
    };
  }

  async function getChildren(pid: string): Promise<Array<{ id: string; title: string }>> {
    const results: Array<{ id: string; title: string }> = [];
    let cursor: string | null = null;
    do {
      const qs = cursor ? `?limit=50&cursor=${cursor}` : "?limit=50";
      const data = await api(`/pages/${pid}/children/page${qs}`);
      for (const r of data.results ?? []) {
        results.push({ id: r.id, title: r.title });
      }
      // Pagination: extract cursor from next link if present
      const nextLink: string | undefined = data._links?.next;
      cursor = nextLink
        ? new URL(nextLink, baseApi).searchParams.get("cursor")
        : null;
    } while (cursor);
    return results;
  }

  // ── Recursive import ──

  async function importPage(
    pid: string,
    space: string,
    depth: number
  ): Promise<ConfluencePageNode> {
    if (pageCount >= config.maxPages) {
      throw new Error(
        `Reached max page limit (${config.maxPages}). ` +
          `Configure atlassian.max_pages to increase.`
      );
    }

    const page = await getPage(pid);
    pageCount++;

    const slug = slugify(page.title);
    const relPath = `confluence/${space}/${slug}.html`;
    const absPath = join(rawDir, relPath);

    if (!existsSync(absPath)) {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, page.html);
      const h = hash(page.html);
      writeMeta(absPath, {
        path: relPath,
        sourceUrl: `https://${host}/wiki/spaces/${space}/pages/${pid}`,
        downloadedAt: new Date().toISOString(),
        sha256: h,
        size: Buffer.byteLength(page.html),
        mimeType: "text/html",
        description: `Confluence: ${page.title}`,
        tags: ["confluence", space],
      });
      files.push(relPath);
    }

    // Recurse children
    const children: ConfluencePageNode[] = [];
    if (depth < maxDepth) {
      const kids = await getChildren(pid);
      for (const kid of kids) {
        if (pageCount >= config.maxPages) break;
        children.push(await importPage(kid.id, space, depth + 1));
      }
    }

    return { id: pid, title: page.title, file: relPath, children };
  }

  // ── Execute ──

  // Extract space key from URL
  const spaceMatch = url.match(/spaces\/([A-Za-z0-9_~-]+)/);
  const spaceKey = spaceMatch?.[1] ?? "default";

  const tree = await importPage(pageId, spaceKey, 0);

  // Write tree structure file
  const treePath = join(rawDir, `confluence/${spaceKey}/_tree.yaml`);
  mkdirSync(dirname(treePath), { recursive: true });
  writeFileSync(treePath, yaml.dump(tree, { lineWidth: 100 }));

  return { pages: pageCount, tree, files };
}

// ═══════════════════════════════════════════════════════════════
//  JIRA
// ═══════════════════════════════════════════════════════════════

export function parseJiraUrl(
  url: string
): { host: string; issueKey: string } {
  const match = url.match(/https?:\/\/([^/]+)\/browse\/([A-Z][A-Z0-9]+-\d+)/);
  if (!match) {
    throw new Error(
      `Cannot parse Jira URL: "${url}". ` +
        `Expected: https://company.atlassian.net/browse/PROJ-123`
    );
  }
  return { host: match[1]!, issueKey: match[2]! };
}

export async function jiraImport(
  url: string,
  rawDir: string,
  config: AtlassianConfig,
  opts: {
    includeComments?: boolean;
    includeAttachments?: boolean;
    includeLinks?: boolean;
    linkDepth?: number;
    authEnv?: string;
  } = {}
): Promise<JiraImportResult> {
  const { host, issueKey } = parseJiraUrl(url);
  validateHost(host, config.allowedHosts);

  const authHeader = resolveAuth(opts.authEnv ?? "JIRA_API_TOKEN");
  const linkDepth = opts.linkDepth ?? 1;
  const wantComments = opts.includeComments ?? true;
  const wantAttachments = opts.includeAttachments ?? true;
  const wantLinks = opts.includeLinks ?? true;

  const baseApi = `https://${host}/rest/api/3`;
  const files: string[] = [];
  const imported = new Set<string>();

  async function api(endpoint: string): Promise<any> {
    const resp = await fetch(`${baseApi}${endpoint}`, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": `agent-wiki/${VERSION}`,
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Jira API ${resp.status} ${resp.statusText} — ${endpoint}\n${body.slice(0, 500)}`
      );
    }
    return resp.json();
  }

  async function downloadAttachment(
    attUrl: string,
    filename: string,
    destDir: string
  ): Promise<string | null> {
    try {
      const resp = await fetch(attUrl, {
        headers: {
          Authorization: authHeader,
          "User-Agent": `agent-wiki/${VERSION}`,
        },
        redirect: "follow",
      });
      if (!resp.ok || !resp.body) return null;

      const cl = parseInt(resp.headers.get("content-length") ?? "0", 10);
      if (cl > config.maxAttachmentSize) return null;

      const dest = join(destDir, filename);
      if (existsSync(dest)) return dest;

      mkdirSync(dirname(dest), { recursive: true });
      const nodeStream = Readable.fromWeb(resp.body as any);
      const ws = createWriteStream(dest);
      await pipeline(nodeStream, ws);
      return dest;
    } catch {
      return null; // skip failed attachments silently
    }
  }

  async function importIssue(key: string, depth: number): Promise<void> {
    if (imported.has(key)) return;
    imported.add(key);

    const issue = await api(
      `/issue/${key}?expand=renderedFields,names&fields=*all`
    );
    const f = issue.fields ?? {};
    const rf = issue.renderedFields ?? {};

    const dir = `jira/${key}`;
    const absDir = join(rawDir, dir);
    mkdirSync(absDir, { recursive: true });

    // ── Save raw JSON ──
    const jsonStr = JSON.stringify(issue, null, 2);
    const jsonPath = join(absDir, `${key}.json`);
    writeFileSync(jsonPath, jsonStr);
    writeMeta(jsonPath, {
      path: `${dir}/${key}.json`,
      sourceUrl: `https://${host}/browse/${key}`,
      downloadedAt: new Date().toISOString(),
      sha256: hash(jsonStr),
      size: Buffer.byteLength(jsonStr),
      mimeType: "application/json",
      description: `Jira: ${key} — ${f.summary ?? ""}`,
      tags: ["jira", key.split("-")[0]!],
    });
    files.push(`${dir}/${key}.json`);

    // ── Build readable Markdown ──
    const project = key.split("-")[0]!;
    const md: string[] = [];

    md.push("---");
    md.push(`title: "${key}: ${(f.summary ?? "").replace(/"/g, '\\"')}"`);
    md.push("type: artifact");
    md.push(
      `tags: [jira, ${project}, ${(f.issuetype?.name ?? "issue").toLowerCase()}]`
    );
    md.push(`sources: ["https://${host}/browse/${key}"]`);
    md.push("---");
    md.push("");

    // Fields table
    md.push("| Field | Value |");
    md.push("|-------|-------|");
    md.push(`| Type | ${f.issuetype?.name ?? "—"} |`);
    md.push(`| Status | ${f.status?.name ?? "—"} |`);
    md.push(`| Priority | ${f.priority?.name ?? "—"} |`);

    const sp =
      f.story_points ?? f.customfield_10016 ?? f.story_point_estimate;
    if (sp != null) md.push(`| Story Points | ${sp} |`);

    if (f.assignee) md.push(`| Assignee | ${f.assignee.displayName} |`);
    if (f.reporter) md.push(`| Reporter | ${f.reporter.displayName} |`);
    if (f.labels?.length) md.push(`| Labels | ${f.labels.join(", ")} |`);
    if (f.components?.length)
      md.push(
        `| Components | ${f.components.map((c: any) => c.name).join(", ")} |`
      );

    const sprint = f.sprint ?? f.customfield_10020;
    if (sprint) {
      const name =
        typeof sprint === "object" ? (sprint as any).name : String(sprint);
      if (name) md.push(`| Sprint | ${name} |`);
    }

    md.push("");

    // Description
    const desc = rf.description ?? f.description;
    if (desc) {
      md.push("## Description");
      md.push("");
      if (typeof desc === "string") {
        md.push(
          desc
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        );
      } else {
        // ADF (Atlassian Document Format) — extract text
        md.push(extractAdfText(desc));
      }
      md.push("");
    }

    // Comments
    if (wantComments) {
      const comments =
        rf.comment?.comments ?? f.comment?.comments ?? [];
      if (comments.length > 0) {
        md.push(`## Comments (${comments.length})`);
        md.push("");
        for (const c of comments) {
          const author = c.author?.displayName ?? "Unknown";
          const date = c.created ? c.created.slice(0, 10) : "—";
          md.push(`### ${author} — ${date}`);
          md.push("");
          const body =
            typeof c.body === "string"
              ? c.body
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
              : extractAdfText(c.body);
          md.push(body);
          md.push("");
        }
      }
    }

    // Attachments
    if (wantAttachments && f.attachment?.length) {
      md.push(`## Attachments (${f.attachment.length})`);
      md.push("");
      for (const att of f.attachment) {
        const size = att.size ? fmtBytes(att.size) : "—";
        const skipped =
          att.size > config.maxAttachmentSize ? " _(skipped — too large)_" : "";
        md.push(`- ${att.filename} (${size})${skipped}`);

        if (att.content && (att.size ?? 0) <= config.maxAttachmentSize) {
          const dlPath = await downloadAttachment(
            att.content,
            att.filename,
            join(absDir, "attachments")
          );
          if (dlPath) {
            const buf = readFileSync(dlPath);
            const relPath = `${dir}/attachments/${att.filename}`;
            writeMeta(dlPath, {
              path: relPath,
              sourceUrl: att.content,
              downloadedAt: new Date().toISOString(),
              sha256: hash(buf),
              size: buf.length,
              mimeType: att.mimeType ?? "application/octet-stream",
              description: `Attachment from ${key}: ${att.filename}`,
              tags: ["jira", "attachment", project],
            });
            files.push(relPath);
          }
        }
      }
      md.push("");
    }

    // Linked issues
    const linkedKeys: string[] = [];
    if (wantLinks && f.issuelinks?.length) {
      md.push(`## Linked Issues (${f.issuelinks.length})`);
      md.push("");
      for (const link of f.issuelinks) {
        const outward = link.outwardIssue;
        const inward = link.inwardIssue;
        if (outward) {
          md.push(
            `- **${link.type?.outward ?? "relates to"}** ${outward.key}: ${outward.fields?.summary ?? ""}`
          );
          linkedKeys.push(outward.key);
        }
        if (inward) {
          md.push(
            `- **${link.type?.inward ?? "relates to"}** ${inward.key}: ${inward.fields?.summary ?? ""}`
          );
          linkedKeys.push(inward.key);
        }
      }
      md.push("");
    }

    // Save markdown
    const mdStr = md.join("\n");
    const mdPath = join(absDir, `${key}.md`);
    writeFileSync(mdPath, mdStr);
    writeMeta(mdPath, {
      path: `${dir}/${key}.md`,
      sourceUrl: `https://${host}/browse/${key}`,
      downloadedAt: new Date().toISOString(),
      sha256: hash(mdStr),
      size: Buffer.byteLength(mdStr),
      mimeType: "text/markdown",
      description: `Jira summary: ${key} — ${f.summary ?? ""}`,
      tags: ["jira", project],
    });
    files.push(`${dir}/${key}.md`);

    // Recurse linked issues
    if (wantLinks && depth < linkDepth) {
      for (const lk of linkedKeys) {
        await importIssue(lk, depth + 1);
      }
    }
  }

  // ── Execute ──
  await importIssue(issueKey, 0);

  return {
    issueKey,
    summary: `Imported ${imported.size} issue(s), ${files.length} file(s)`,
    files,
    linkedIssues: [...imported].filter((k) => k !== issueKey),
    importedCount: imported.size,
  };
}

// ── ADF text extraction ───────────────────────────────────────

/** Best-effort text extraction from Atlassian Document Format (ADF). */
function extractAdfText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).join(
      node.type === "paragraph" || node.type === "heading" ? "\n" : ""
    );
  }
  return "";
}
