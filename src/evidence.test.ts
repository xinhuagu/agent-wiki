import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceEnvelope } from "./evidence.js";

describe("EvidenceEnvelope (phase 0 — language-agnostic shape)", () => {
  it("accepts a fully-populated envelope with multiple provenance entries", () => {
    const env: EvidenceEnvelope = {
      provenance: [
        { raw: "raw/source-file", line: 42 },
        { wikiPage: "wiki/page.md" },
      ],
      confidence: "strong",
      basis: "deterministic",
      abstain: false,
      rationale: "Match found in two parsed sources at line 42.",
    };
    expect(env.confidence).toBe("strong");
    expect(env.provenance).toHaveLength(2);
  });

  it("accepts an empty-provenance envelope for absent / unsupported cases", () => {
    const env: EvidenceEnvelope = {
      provenance: [],
      confidence: "absent",
      basis: "unsupported",
      abstain: true,
      rationale: "No matches above the relative percentile or absolute floor.",
    };
    expect(env.abstain).toBe(true);
    expect(env.provenance).toHaveLength(0);
  });

  describe("language-agnostic boundary", () => {
    // Source-file grep — catches both runtime exports (functions, values)
    // AND type-only exports, which a runtime `import` check cannot see.
    // Comment-only references are also caught: the core module's docstrings
    // are supposed to stay neutral so a future Java/Python plugin author
    // doesn't read code that implies COBOL is special.
    const source = readFileSync(resolve(process.cwd(), "src/evidence.ts"), "utf-8");

    const KNOWN_PLUGIN_NAMES = ["cobol"];

    for (const name of KNOWN_PLUGIN_NAMES) {
      it(`does not mention "${name}" anywhere in src/evidence.ts`, () => {
        const pattern = new RegExp(name, "i");
        expect(source).not.toMatch(pattern);
      });
    }

    it("does not import from any plugin directory", () => {
      // Imports would look like `from "./cobol/..."` or `from "./java/..."`.
      // Bare top-level imports are fine; cross-plugin imports are not.
      expect(source).not.toMatch(/from\s+["'][.][/]([a-z]+)[/]/);
    });
  });
});
