/**
 * Integration tests for confluenceImport that exercise the version /
 * history persistence path added by #27. Drives the importer with mocked
 * fetch responses; no live API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { confluenceImport, ATLASSIAN_DEFAULTS } from "./atlassian.js";

type Route = (url: string) => Promise<Partial<Response>> | Partial<Response>;

interface MockResponse {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  // Minimal Response-shaped object that satisfies the production code's
  // .ok / .status / .statusText / .json() / .text() reads.
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetchMock(routes: Array<{ match: RegExp; resp: MockResponse | Route }>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      if (route.match.test(url)) {
        if (typeof route.resp === "function") {
          const r = await route.resp(url);
          return r as Response;
        }
        return jsonResponse(route.resp.body, route.resp.status ?? 200);
      }
    }
    return jsonResponse({ error: `unrouted: ${url}` }, 404);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function readSidecar(rawDir: string, space: string, slug: string): Record<string, any> {
  const sidecar = join(rawDir, `confluence/${space}/${slug}.html.meta.yaml`);
  expect(existsSync(sidecar)).toBe(true);
  return yaml.load(readFileSync(sidecar, "utf-8")) as Record<string, any>;
}

describe("confluenceImport — version & history persistence (#27)", () => {
  let rawDir: string;
  let originalFetch: typeof fetch;
  let originalToken: string | undefined;

  beforeEach(() => {
    rawDir = mkdtempSync(join(tmpdir(), "confluence-test-"));
    originalFetch = globalThis.fetch;
    originalToken = process.env.CONFLUENCE_API_TOKEN;
    process.env.CONFLUENCE_API_TOKEN = "test@example.com:testtoken";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.CONFLUENCE_API_TOKEN;
    else process.env.CONFLUENCE_API_TOKEN = originalToken;
    rmSync(rawDir, { recursive: true, force: true });
  });

  it("Cloud: writes version + history (with displayName via /users) into .meta.yaml", async () => {
    const spy = installFetchMock([
      {
        match: /\/wiki\/api\/v2\/pages\/12345\?body-format=storage/,
        resp: {
          body: {
            id: "12345",
            title: "Architecture Overview",
            body: { storage: { value: "<p>hello</p>" } },
            version: { createdAt: "2026-05-01T10:00:00Z", number: 7 },
            createdAt: "2025-12-01T08:00:00Z",
            authorId: "557058:abcd-efgh",
          },
        },
      },
      {
        match: /\/wiki\/api\/v2\/users\/557058:abcd-efgh/,
        resp: { body: { displayName: "Alice Author" } },
      },
      { match: /\/attachments(\?|$)/, resp: { body: { results: [] } } },
      { match: /\/children\/page(\?|$)/, resp: { body: { results: [] } } },
    ]);

    await confluenceImport(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Architecture-Overview",
      rawDir,
      { ...ATLASSIAN_DEFAULTS },
    );

    const meta = readSidecar(rawDir, "ENG", "architecture-overview");
    expect(meta.confluence).toEqual({
      version: { when: "2026-05-01T10:00:00Z", number: 7 },
      history: {
        createdDate: "2025-12-01T08:00:00Z",
        createdBy: { displayName: "Alice Author" },
      },
    });
    expect(spy.mock.calls.some(([u]) => String(u).includes("/users/557058:abcd-efgh"))).toBe(true);
  });

  it("Cloud: omits createdBy when /users lookup 404s, keeps version + createdDate", async () => {
    installFetchMock([
      {
        match: /\/wiki\/api\/v2\/pages\/12345\?body-format=storage/,
        resp: {
          body: {
            id: "12345",
            title: "Solo Page",
            body: { storage: { value: "<p>x</p>" } },
            version: { createdAt: "2026-05-01T10:00:00Z", number: 1 },
            createdAt: "2025-12-01T08:00:00Z",
            authorId: "missing-user",
          },
        },
      },
      { match: /\/users\//, resp: { body: { error: "not found" }, status: 404, ok: false } },
      { match: /\/attachments(\?|$)/, resp: { body: { results: [] } } },
      { match: /\/children\/page(\?|$)/, resp: { body: { results: [] } } },
    ]);

    await confluenceImport(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Solo-Page",
      rawDir,
      { ...ATLASSIAN_DEFAULTS },
    );

    const meta = readSidecar(rawDir, "ENG", "solo-page");
    expect(meta.confluence).toEqual({
      version: { when: "2026-05-01T10:00:00Z", number: 1 },
      history: { createdDate: "2025-12-01T08:00:00Z" },
    });
  });

  it("Cloud: caches /users lookups across a recursive import", async () => {
    const spy = installFetchMock([
      {
        match: /\/wiki\/api\/v2\/pages\/100\?body-format=storage/,
        resp: {
          body: {
            id: "100", title: "Parent",
            body: { storage: { value: "p" } },
            version: { createdAt: "2026-05-01T10:00:00Z", number: 1 },
            createdAt: "2025-12-01T00:00:00Z",
            authorId: "shared-author",
          },
        },
      },
      {
        match: /\/wiki\/api\/v2\/pages\/200\?body-format=storage/,
        resp: {
          body: {
            id: "200", title: "Child",
            body: { storage: { value: "c" } },
            version: { createdAt: "2026-05-02T10:00:00Z", number: 1 },
            createdAt: "2025-12-02T00:00:00Z",
            authorId: "shared-author",
          },
        },
      },
      {
        match: /\/wiki\/api\/v2\/users\/shared-author/,
        resp: { body: { displayName: "Shared Author" } },
      },
      { match: /\/pages\/100\/children\/page/, resp: { body: { results: [{ id: "200", title: "Child" }] } } },
      { match: /\/children\/page(\?|$)/, resp: { body: { results: [] } } },
      { match: /\/attachments(\?|$)/, resp: { body: { results: [] } } },
    ]);

    await confluenceImport(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/100/Parent",
      rawDir,
      { ...ATLASSIAN_DEFAULTS },
      { recursive: true },
    );

    const userCalls = spy.mock.calls.filter(([u]) => String(u).includes("/users/shared-author"));
    expect(userCalls.length).toBe(1);
    expect(readSidecar(rawDir, "ENG", "parent").confluence.history.createdBy).toEqual({ displayName: "Shared Author" });
    expect(readSidecar(rawDir, "ENG", "child").confluence.history.createdBy).toEqual({ displayName: "Shared Author" });
  });

  it("Server: writes version + history inline (no /users follow-up)", async () => {
    const spy = installFetchMock([
      {
        match: /\/rest\/api\/content\/77777\?expand=body\.storage,version,history,history\.createdBy/,
        resp: {
          body: {
            id: 77777,
            title: "DC Page",
            body: { storage: { value: "<p>server</p>" } },
            version: { when: "2026-04-01T12:00:00Z", number: 2 },
            history: {
              createdDate: "2025-11-01T09:00:00Z",
              createdBy: { displayName: "Bob Server" },
            },
          },
        },
      },
      { match: /\/child\/attachment/, resp: { body: { results: [] } } },
      { match: /\/child\/page/, resp: { body: { results: [] } } },
    ]);

    await confluenceImport(
      "https://confluence.example.com/spaces/DEV/pages/77777/DC-Page",
      rawDir,
      { ...ATLASSIAN_DEFAULTS },
    );

    const meta = readSidecar(rawDir, "DEV", "dc-page");
    expect(meta.confluence).toEqual({
      version: { when: "2026-04-01T12:00:00Z", number: 2 },
      history: {
        createdDate: "2025-11-01T09:00:00Z",
        createdBy: { displayName: "Bob Server" },
      },
    });
    // No /users follow-up — server response carried displayName inline.
    expect(spy.mock.calls.every(([u]) => !String(u).includes("/users/"))).toBe(true);
  });

  it("omits the confluence block entirely when the API response carries no version", async () => {
    // Older Server responses, or a Cloud page where the body wasn't returned
    // with expansion, still need to produce a valid sidecar.
    installFetchMock([
      {
        match: /\/wiki\/api\/v2\/pages\/55555\?body-format=storage/,
        resp: {
          body: {
            id: "55555",
            title: "Legacy Page",
            body: { storage: { value: "<p>legacy</p>" } },
            // no version, no createdAt, no authorId
          },
        },
      },
      { match: /\/attachments(\?|$)/, resp: { body: { results: [] } } },
      { match: /\/children\/page(\?|$)/, resp: { body: { results: [] } } },
    ]);

    await confluenceImport(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/55555/Legacy-Page",
      rawDir,
      { ...ATLASSIAN_DEFAULTS },
    );

    const meta = readSidecar(rawDir, "ENG", "legacy-page");
    expect(meta.confluence).toBeUndefined();
    // Core sidecar fields still present so wiki_lint / integrity checks pass.
    expect(meta.path).toBe("confluence/ENG/legacy-page.html");
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
