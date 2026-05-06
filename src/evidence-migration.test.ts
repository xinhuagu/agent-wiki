import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wiki } from "./wiki.js";
import { migrateExistingPagesForEvidence } from "./evidence-migration.js";
import { migrationMarkerPath } from "./evidence-write-log.js";

let tmp: string;
let wiki: Wiki;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-mig-"));
  wiki = Wiki.init(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("migrateExistingPagesForEvidence", () => {
  it("rule 1: pages with type: synthesis are left alone", () => {
    wiki.write("note.md", "---\ntitle: Note\ntype: synthesis\n---\nContent.");
    const result = migrateExistingPagesForEvidence(wiki, []);
    expect(result.preExistingSynthesis).toBe(1);
    const after = wiki.read("note.md");
    expect(after?.frontmatter.synthesis).toBeUndefined();
    expect(after?.frontmatter.legacyUnsupported).toBeUndefined();
  });

  it("rule 2: compiler-generated pages under wiki/<plugin>/... get synthesis: true", () => {
    wiki.write("cobol/system-map.md", "---\ntitle: System Map\n---\nGraph.");
    const result = migrateExistingPagesForEvidence(wiki, ["cobol"]);
    expect(result.syntheses).toBe(1);
    const after = wiki.read("cobol/system-map.md");
    expect(after?.frontmatter.synthesis).toBe(true);
  });

  it("rule 3: pages with non-empty sources are left alone", () => {
    wiki.write("ref.md", "---\ntitle: Ref\nsources: [raw/paper.pdf]\n---\nContent.");
    const result = migrateExistingPagesForEvidence(wiki, []);
    expect(result.grounded).toBe(1);
    const after = wiki.read("ref.md");
    expect(after?.frontmatter.legacyUnsupported).toBeUndefined();
    expect(after?.frontmatter.synthesis).toBeUndefined();
  });

  it("rule 4: pre-existing user pages without sources/synthesis get legacyUnsupported", () => {
    wiki.write("opinion.md", "---\ntitle: Opinion\n---\nMy take.");
    // wiki.write stamps `unsupported: true` on the synthetic setup write.
    // Migration must clear that and replace with `legacyUnsupported: true`
    // so the two flags don't coexist (they have overlapping semantics —
    // legacy is the grandfathered subset of unsupported).
    const result = migrateExistingPagesForEvidence(wiki, []);
    expect(result.legacy).toBe(1);
    const after = wiki.read("opinion.md");
    expect(after?.frontmatter.legacyUnsupported).toBe(true);
    expect(after?.frontmatter.unsupported).toBeUndefined();
  });

  it("is idempotent: second run reports alreadyMigrated and changes nothing", () => {
    wiki.write("a.md", "---\ntitle: A\n---\nNo sources.");
    migrateExistingPagesForEvidence(wiki, []);
    expect(existsSync(migrationMarkerPath(wiki.config.workspace))).toBe(true);

    const second = migrateExistingPagesForEvidence(wiki, []);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.totalPages).toBe(0);
  });

  it("classifies a mixed wiki correctly in one pass", () => {
    wiki.write("grounded.md", "---\ntitle: G\nsources: [raw/x.md]\n---\nA.");
    wiki.write("synth.md", "---\ntitle: S\ntype: synthesis\n---\nB.");
    wiki.write("cobol/system-map.md", "---\ntitle: Map\n---\nGraph.");
    wiki.write("opinion.md", "---\ntitle: O\n---\nMy take.");
    wiki.write("nested/deep.md", "---\ntitle: D\nsources: [raw/y.md]\n---\nE.");

    const result = migrateExistingPagesForEvidence(wiki, ["cobol"]);
    expect(result.grounded).toBe(2);              // grounded.md + nested/deep.md
    expect(result.preExistingSynthesis).toBe(1);  // synth.md
    expect(result.syntheses).toBe(1);             // cobol/system-map.md
    expect(result.legacy).toBe(1);                // opinion.md
  });
});
