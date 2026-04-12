/**
 * Tests for the extraction module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePageRange, guessMime, chunkSegments, extractDocument, type ExtractionSegment } from "./extraction.js";

const TEST_ROOT = join(import.meta.dirname ?? ".", "__test_extraction__");

function cleanUp() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

describe("parsePageRange", () => {
  it("parses single page", () => {
    expect([...parsePageRange("3", 10)]).toEqual([2]); // 0-based
  });

  it("parses range", () => {
    const result = [...parsePageRange("1-5", 10)].sort((a, b) => a - b);
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it("parses comma-separated ranges", () => {
    const result = [...parsePageRange("1-3,7-10", 10)].sort((a, b) => a - b);
    expect(result).toEqual([0, 1, 2, 6, 7, 8, 9]);
  });

  it("returns empty for out-of-bounds page", () => {
    expect(parsePageRange("15", 10).size).toBe(0);
  });

  it("clamps range to total pages", () => {
    const result = [...parsePageRange("8-20", 10)].sort((a, b) => a - b);
    expect(result).toEqual([7, 8, 9]);
  });
});

describe("guessMime", () => {
  it("returns correct MIME for PDF", () => {
    expect(guessMime("doc.pdf")).toBe("application/pdf");
  });

  it("returns correct MIME for Markdown", () => {
    expect(guessMime("readme.md")).toBe("text/markdown");
  });

  it("returns octet-stream for unknown extension", () => {
    expect(guessMime("data.xyz123")).toBe("application/octet-stream");
  });
});

describe("chunkSegments", () => {
  it("returns segment unchanged if under maxLines", () => {
    const seg: ExtractionSegment = { text: "line1\nline2\nline3", source: { file: "f.txt" } };
    const result = chunkSegments([seg], 10);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("line1\nline2\nline3");
  });

  it("splits large segment into chunks", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
    const seg: ExtractionSegment = { text: lines, source: { file: "big.txt" } };
    const result = chunkSegments([seg], 10);
    expect(result).toHaveLength(3); // 10 + 10 + 5
    expect(result[0].text.split("\n").length).toBe(10);
    expect(result[2].text.split("\n").length).toBe(5);
  });

  it("preserves source coordinates across chunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const seg: ExtractionSegment = { text: lines, source: { file: "doc.pdf", page: 3 } };
    const result = chunkSegments([seg], 10);
    expect(result).toHaveLength(2);
    expect(result[0].source.page).toBe(3);
    expect(result[1].source.page).toBe(3);
    expect(result[0].source.file).toBe("doc.pdf");
  });

  it("handles multiple segments with mixed sizes", () => {
    const segs: ExtractionSegment[] = [
      { text: "small", source: { file: "a.txt" } },
      { text: Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n"), source: { file: "b.txt" } },
    ];
    const result = chunkSegments(segs, 10);
    expect(result).toHaveLength(3); // 1 (small) + 2 (15/10)
  });

  it("prepends columnHeaders to non-first chunks only", () => {
    const header = "id,name,salary";
    const dataLines = Array.from({ length: 25 }, (_, i) => `${i},Alice,${i * 1000}`).join("\n");
    const seg: ExtractionSegment = {
      text: `${header}\n${dataLines}`,
      source: { file: "payroll.xlsx", sheet: "Sheet1" },
      columnHeaders: header,
    };
    const result = chunkSegments([seg], 10);
    // 26 lines (1 header + 25 data) → ceiling(26/10) = 3 chunks
    expect(result).toHaveLength(3);
    // First chunk already contains the header row — no prefix added
    expect(result[0].text.startsWith(header)).toBe(true);
    expect(result[0].text.indexOf(header)).toBe(0); // appears once
    // Second chunk: header prepended
    expect(result[1].text.startsWith(header + "\n")).toBe(true);
    // Ensure original data lines still present in second chunk
    expect(result[1].text).toContain(",Alice,");
    // Third chunk: header prepended
    expect(result[2].text.startsWith(header + "\n")).toBe(true);
    // columnHeaders propagated to all chunks
    for (const chunk of result) {
      expect(chunk.columnHeaders).toBe(header);
    }
  });

  it("does not add headers to a segment without columnHeaders", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const seg: ExtractionSegment = { text: lines, source: { file: "plain.txt" } };
    const result = chunkSegments([seg], 10);
    expect(result).toHaveLength(2);
    expect(result[0].columnHeaders).toBeUndefined();
    expect(result[1].columnHeaders).toBeUndefined();
    // No header line injected
    expect(result[1].text).not.toContain("line 0");
  });
});

describe("extractDocument", () => {
  beforeEach(() => {
    cleanUp();
    mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterEach(cleanUp);

  it("extracts HTML into single segment with provenance", async () => {
    const htmlPath = join(TEST_ROOT, "test.html");
    writeFileSync(htmlPath, "<html><head><style>body{}</style></head><body><p>Hello</p><p>World</p></body></html>");
    const result = await extractDocument(htmlPath);
    expect(result.format).toBe("html");
    expect(result.mimeType).toBe("text/html");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toContain("Hello");
    expect(result.segments[0].text).toContain("World");
    expect(result.segments[0].text).not.toContain("style");
    expect(result.segments[0].source.file).toBe(htmlPath);
  });

  it("throws for unsupported format", async () => {
    const binPath = join(TEST_ROOT, "data.xyz");
    writeFileSync(binPath, "binary stuff");
    await expect(extractDocument(binPath)).rejects.toThrow(/unsupported/i);
  });
});
