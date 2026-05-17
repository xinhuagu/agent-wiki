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
  statSync,
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

/**
 * Provenance metadata fetched from Confluence alongside the page body. Lets a
 * downstream tool answer "who last changed this, when, and which revision is
 * this?" without re-querying the source. Optional everywhere — older sidecars
 * predate this block, and not every Cloud response carries `history.createdBy`
 * cheaply (see Cloud `getPage` below for the /users follow-up cache).
 */
export interface ConfluenceMeta {
  version: {
    /** Last-modified timestamp of *this* revision, ISO 8601. */
    when: string;
    /** Page revision number (1-indexed). */
    number: number;
  };
  history?: {
    /** Page creation timestamp, ISO 8601. */
    createdDate: string;
    /** Original author. `displayName` may be absent on Cloud if the /users lookup failed. */
    createdBy?: { displayName: string };
  };
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
  /**
   * Confluence-only provenance. Present on page sidecars when
   * `raw_ingest --mode import_confluence` carried version / history through;
   * absent on attachment sidecars and on legacy sidecars from pre-#27 imports.
   */
  confluence?: ConfluenceMeta;
}

// ── Helpers ───────────────────────────────────────────────────

export function resolveAuth(authEnv: string): string {
  const value = process.env[authEnv];
  if (!value) {
    throw new Error(
      `Environment variable "${authEnv}" is not set. Set it to one of:\n` +
        `  - "email:api-token"  (Atlassian Cloud Basic auth — auto-encoded)\n` +
        `  - "Bearer <pat>"     (Server / Data Center, explicit prefix)\n` +
        `  - "<pat>"            (Server / Data Center, bare PAT — Bearer added automatically)\n` +
        `Pass a different env var name via the tool's authEnv parameter if your deployment uses a custom convention.`
    );
  }
  // Already prefixed — pass through verbatim.
  if (value.startsWith("Basic ") || value.startsWith("Bearer ")) {
    return value;
  }
  // email:token shape → Cloud Basic auth.
  if (value.includes(":")) {
    return `Basic ${Buffer.from(value).toString("base64")}`;
  }
  // Bare token (no colon, no prefix) → Server / DC Bearer convention.
  return `Bearer ${value}`;
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

export type AtlassianDeployment = "cloud" | "server";

export function parseConfluenceUrl(
  url: string
): { host: string; pageId: string; deployment: AtlassianDeployment } {
  // Cloud: https://{host}/wiki/spaces/SPACE/pages/12345/...
  const cloudMatch = url.match(/https?:\/\/([^/]+)\/wiki\/.*?pages\/(\d+)/);
  if (cloudMatch) {
    return { host: cloudMatch[1]!, pageId: cloudMatch[2]!, deployment: "cloud" };
  }
  // Server / Data Center: https://{host}/spaces/SPACE/pages/12345/...
  // (no `/wiki/` segment; everything else identical)
  const serverMatch = url.match(/https?:\/\/([^/]+)\/(?!wiki\/).*?pages\/(\d+)/);
  if (serverMatch) {
    return { host: serverMatch[1]!, pageId: serverMatch[2]!, deployment: "server" };
  }
  throw new Error(
    `Cannot parse Confluence URL: "${url}". ` +
      `Expected one of:\n` +
      `  - Cloud:  https://company.atlassian.net/wiki/spaces/SPACE/pages/12345/...\n` +
      `  - Server: https://confluence.example.com/spaces/SPACE/pages/12345/...`
  );
}

/**
 * Internal normalized shape — same regardless of Cloud vs Server / DC origin.
 * Platform-specific clients below project their respective response schemas
 * into these types so the rest of confluenceImport can stay platform-agnostic.
 */
interface NormalizedConfluencePage {
  id: string;
  title: string;
  html: string;
  /**
   * Version / history block carried into the sidecar (#27). Optional because
   * (a) older Server responses without expand= omit the data, and (b) Cloud
   * v2's basic page response doesn't include `history.createdBy` — the Cloud
   * client does a follow-up /users lookup for displayName but can fall back
   * to omitting it on auth scope or transient failure.
   */
  meta?: ConfluenceMeta;
}
interface NormalizedConfluenceAttachment {
  title: string;
  downloadLink: string;
  mediaType: string;
  fileSize: number;
}
interface NormalizedConfluenceChild {
  id: string;
  title: string;
}

interface ConfluenceClient {
  getPage(pid: string): Promise<NormalizedConfluencePage>;
  getAttachments(pid: string): Promise<NormalizedConfluenceAttachment[]>;
  getChildren(pid: string): Promise<NormalizedConfluenceChild[]>;
}

/**
 * Project a Confluence Cloud v2 `/pages/{id}` response into the shared
 * `ConfluenceMeta` shape. Cloud v2 returns `version.createdAt` (timestamp of
 * the current revision) and `data.createdAt` (page creation time, the v1
 * equivalent of `history.createdDate`), but `history.createdBy.displayName`
 * has to be resolved through a follow-up /users call by the caller.
 *
 * Returns `undefined` when neither `version` nor a `createdAt` block is
 * present so the caller can omit the field entirely instead of emitting a
 * half-empty object.
 */
async function projectCloudMeta(
  data: any,
  resolveDisplayName: (accountId?: string) => Promise<string | undefined>,
): Promise<ConfluenceMeta | undefined> {
  const versionWhen = data?.version?.createdAt;
  const versionNumber = data?.version?.number;
  if (typeof versionWhen !== "string" || typeof versionNumber !== "number") {
    // version is non-optional in ConfluenceMeta — without both fields we
    // can't construct a valid block, so skip the whole sidecar addition.
    return undefined;
  }
  const meta: ConfluenceMeta = {
    version: { when: versionWhen, number: versionNumber },
  };
  const createdDate = data?.createdAt;
  if (typeof createdDate === "string") {
    const displayName = await resolveDisplayName(data?.authorId);
    meta.history = {
      createdDate,
      ...(displayName ? { createdBy: { displayName } } : {}),
    };
  }
  return meta;
}

/**
 * Project a Confluence Server / Data Center v1 `/content/{id}?expand=...`
 * response. v1 carries the full history block inline (including
 * `history.createdBy.displayName`), so no follow-up call is needed.
 */
function projectServerMeta(data: any): ConfluenceMeta | undefined {
  const versionWhen = data?.version?.when;
  const versionNumber = data?.version?.number;
  if (typeof versionWhen !== "string" || typeof versionNumber !== "number") {
    return undefined;
  }
  const meta: ConfluenceMeta = {
    version: { when: versionWhen, number: versionNumber },
  };
  const createdDate = data?.history?.createdDate;
  if (typeof createdDate === "string") {
    const displayName = data?.history?.createdBy?.displayName;
    meta.history = {
      createdDate,
      ...(typeof displayName === "string" && displayName.length > 0
        ? { createdBy: { displayName } }
        : {}),
    };
  }
  return meta;
}

function buildConfluenceClient(
  host: string,
  deployment: AtlassianDeployment,
  authHeader: string,
): ConfluenceClient {
  const baseApi =
    deployment === "cloud"
      ? `https://${host}/wiki/api/v2`
      : `https://${host}/rest/api`;

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

  if (deployment === "cloud") {
    // Per-import cache of accountId → displayName. Confluence Cloud v2's basic
    // page response carries `authorId` but not `displayName`, so we resolve it
    // via /users/{accountId}. A recursive import of 100 pages by the same
    // handful of authors collapses to a few lookups instead of 100.
    // Misses (network failure, permission scope) cache as `null` to avoid
    // re-firing the call repeatedly.
    const userCache = new Map<string, string | null>();
    async function resolveDisplayName(accountId?: string): Promise<string | undefined> {
      if (!accountId) return undefined;
      const cached = userCache.get(accountId);
      if (cached !== undefined) return cached ?? undefined;
      try {
        const u = await api(`/users/${accountId}`);
        const name = typeof u?.displayName === "string" ? u.displayName : null;
        userCache.set(accountId, name);
        return name ?? undefined;
      } catch {
        // Don't block the import on a user lookup; just omit displayName.
        userCache.set(accountId, null);
        return undefined;
      }
    }

    return {
      async getPage(pid) {
        const data = await api(`/pages/${pid}?body-format=storage`);
        const meta = await projectCloudMeta(data, resolveDisplayName);
        return {
          id: data.id,
          title: data.title,
          html: data.body?.storage?.value ?? "",
          ...(meta ? { meta } : {}),
        };
      },
      async getAttachments(pid) {
        const results: NormalizedConfluenceAttachment[] = [];
        let cursor: string | null = null;
        do {
          const qs = cursor ? `?limit=50&cursor=${cursor}` : "?limit=50";
          const data = await api(`/pages/${pid}/attachments${qs}`);
          for (const r of data.results ?? []) {
            results.push({
              title: r.title ?? r.id,
              downloadLink: r._links?.download ? `https://${host}/wiki${r._links.download}` : "",
              mediaType: r.mediaType ?? "application/octet-stream",
              fileSize: r.fileSize ?? 0,
            });
          }
          const nextLink: string | undefined = data._links?.next;
          cursor = nextLink
            ? new URL(nextLink, baseApi).searchParams.get("cursor")
            : null;
        } while (cursor);
        return results;
      },
      async getChildren(pid) {
        const results: NormalizedConfluenceChild[] = [];
        let cursor: string | null = null;
        do {
          const qs = cursor ? `?limit=50&cursor=${cursor}` : "?limit=50";
          const data = await api(`/pages/${pid}/children/page${qs}`);
          for (const r of data.results ?? []) {
            results.push({ id: r.id, title: r.title });
          }
          const nextLink: string | undefined = data._links?.next;
          cursor = nextLink
            ? new URL(nextLink, baseApi).searchParams.get("cursor")
            : null;
        } while (cursor);
        return results;
      },
    };
  }

  // Server / Data Center — /rest/api/content/* endpoints, start+limit pagination,
  // body returned via ?expand=body.storage.
  return {
    async getPage(pid) {
      // Expand version + history + history.createdBy inline (#27). v1 returns
      // displayName directly under history.createdBy.displayName so we don't
      // need the follow-up /users call the Cloud client does.
      const data = await api(
        `/content/${pid}?expand=body.storage,version,history,history.createdBy`,
      );
      const meta = projectServerMeta(data);
      return {
        id: String(data.id),
        title: data.title ?? "",
        html: data.body?.storage?.value ?? "",
        ...(meta ? { meta } : {}),
      };
    },
    async getAttachments(pid) {
      const results: NormalizedConfluenceAttachment[] = [];
      let start = 0;
      const limit = 50;
      while (true) {
        const data = await api(
          `/content/${pid}/child/attachment?limit=${limit}&start=${start}&expand=metadata,extensions`
        );
        const batch = data.results ?? [];
        for (const r of batch) {
          const dl = r._links?.download;
          results.push({
            title: r.title ?? r.id,
            downloadLink: dl ? `https://${host}${dl}` : "",
            mediaType: r.metadata?.mediaType ?? r.extensions?.mediaType ?? "application/octet-stream",
            fileSize: r.extensions?.fileSize ?? 0,
          });
        }
        if (batch.length < limit) break;
        start += limit;
      }
      return results;
    },
    async getChildren(pid) {
      const results: NormalizedConfluenceChild[] = [];
      let start = 0;
      const limit = 50;
      while (true) {
        const data = await api(`/content/${pid}/child/page?limit=${limit}&start=${start}`);
        const batch = data.results ?? [];
        for (const r of batch) {
          results.push({ id: String(r.id), title: r.title });
        }
        if (batch.length < limit) break;
        start += limit;
      }
      return results;
    },
  };
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
  const { host, pageId, deployment } = parseConfluenceUrl(url);
  validateHost(host, config.allowedHosts);

  const authHeader = resolveAuth(opts.authEnv ?? "CONFLUENCE_API_TOKEN");
  const maxDepth = opts.depth ?? (opts.recursive ? 50 : 0);
  const client = buildConfluenceClient(host, deployment, authHeader);
  const files: string[] = [];
  let pageCount = 0;

  const getPage = (pid: string) => client.getPage(pid);
  const getAttachments = (pid: string) => client.getAttachments(pid);
  const getChildren = (pid: string) => client.getChildren(pid);

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

      const dest = join(destDir, filename);
      if (existsSync(dest)) return dest;

      mkdirSync(dirname(dest), { recursive: true });
      const nodeStream = Readable.fromWeb(resp.body as any);
      const ws = createWriteStream(dest);
      await pipeline(nodeStream, ws);
      return dest;
    } catch {
      return null;
    }
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
      const pageUrlPrefix = deployment === "cloud" ? "/wiki/spaces" : "/spaces";
      writeMeta(absPath, {
        path: relPath,
        sourceUrl: `https://${host}${pageUrlPrefix}/${space}/pages/${pid}`,
        downloadedAt: new Date().toISOString(),
        sha256: h,
        size: Buffer.byteLength(page.html),
        mimeType: "text/html",
        description: `Confluence: ${page.title}`,
        tags: ["confluence", space],
        ...(page.meta ? { confluence: page.meta } : {}),
      });
      files.push(relPath);
    }

    // Download attachments (images, PDFs, etc.)
    const attachments = await getAttachments(pid).catch(() => []);
    const attDir = join(rawDir, `confluence/${space}/attachments`);
    for (const att of attachments) {
      if (!att.downloadLink) continue;
      if (att.fileSize > config.maxAttachmentSize) continue;
      const dlPath = await downloadAttachment(att.downloadLink, att.title, attDir);
      if (dlPath) {
        const buf = readFileSync(dlPath);
        const attRel = `confluence/${space}/attachments/${att.title}`;
        if (!existsSync(dlPath + ".meta.yaml")) {
          writeMeta(dlPath, {
            path: attRel,
            sourceUrl: att.downloadLink,
            downloadedAt: new Date().toISOString(),
            sha256: hash(buf),
            size: statSync(dlPath).size,
            mimeType: att.mediaType,
            description: `Confluence attachment from "${page.title}": ${att.title}`,
            tags: ["confluence", space, "attachment"],
          });
          files.push(attRel);
        }
      }
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
): { host: string; issueKey: string; deployment: AtlassianDeployment } {
  const match = url.match(/https?:\/\/([^/]+)\/browse\/([A-Z][A-Z0-9]+-\d+)/);
  if (!match) {
    throw new Error(
      `Cannot parse Jira URL: "${url}". ` +
        `Expected: https://{host}/browse/PROJ-123 (works for both Cloud and Server / Data Center)`
    );
  }
  // Cloud Jira always lives on *.atlassian.net; anything else is self-hosted.
  const host = match[1]!;
  const deployment: AtlassianDeployment = host.endsWith(".atlassian.net") ? "cloud" : "server";
  return { host, issueKey: match[2]!, deployment };
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
  const { host, issueKey, deployment } = parseJiraUrl(url);
  validateHost(host, config.allowedHosts);

  const authHeader = resolveAuth(opts.authEnv ?? "JIRA_API_TOKEN");
  const linkDepth = opts.linkDepth ?? 1;
  const wantComments = opts.includeComments ?? true;
  const wantAttachments = opts.includeAttachments ?? true;
  const wantLinks = opts.includeLinks ?? true;

  // Cloud always supports v3. Server / DC supports v3 on recent releases and
  // v2 on older ones — try v3 first and fall back to v2 on a 404 from the
  // primary issue endpoint. apiVersion holds whichever the first request
  // ended up using; subsequent requests reuse it without re-probing.
  let apiVersion: "3" | "2" = "3";
  let baseApi = `https://${host}/rest/api/${apiVersion}`;
  const files: string[] = [];
  const imported = new Set<string>();

  async function api(endpoint: string, allowFallback = false): Promise<any> {
    const resp = await fetch(`${baseApi}${endpoint}`, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "User-Agent": `agent-wiki/${VERSION}`,
      },
    });
    if (!resp.ok) {
      // v3 → v2 fallback for older Server / DC. Only honored on the first
      // call (`allowFallback=true` from the initial issue request) so we
      // don't oscillate between versions on later 404s caused by genuinely
      // missing resources.
      if (resp.status === 404 && allowFallback && apiVersion === "3" && deployment === "server") {
        apiVersion = "2";
        baseApi = `https://${host}/rest/api/2`;
        return api(endpoint, false);
      }
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

    // First call may trigger v3 → v2 fallback on older Server / DC; honor that
    // here, then subsequent calls reuse whichever version succeeded.
    const issue = await api(
      `/issue/${key}?expand=renderedFields,names&fields=*all`,
      true
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
