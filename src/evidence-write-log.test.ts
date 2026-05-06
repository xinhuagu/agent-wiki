import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUnsupportedWriteEvent,
  readWriteLog,
  rotateEventLog,
  summarizeLastWeek,
  writeLogPath,
  evidenceDir,
} from "./evidence-write-log.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "evidence-log-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("appendUnsupportedWriteEvent", () => {
  it("creates the .agent-wiki dir and writes a JSONL line", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "concept-x.md",
      timestamp: "2026-05-06T10:00:00.000Z",
      hadSynthesisFlag: false,
      rawSourcesCount: 0,
    });
    const path = writeLogPath(workspace);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.page).toBe("concept-x.md");
  });

  it("appends multiple events as separate lines", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "a.md", timestamp: "2026-05-06T10:00:00.000Z", hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "b.md", timestamp: "2026-05-06T10:01:00.000Z", hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const lines = readFileSync(writeLogPath(workspace), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("does not throw when filesystem write fails", () => {
    // Point at an invalid workspace (nested under a file, not a dir).
    const nonexistent = join(workspace, "not", "a", "real", "path");
    writeFileSync(join(workspace, "not"), "this is a file, not a dir");
    expect(() =>
      appendUnsupportedWriteEvent(nonexistent, {
        page: "x.md", timestamp: "2026-05-06T10:00:00.000Z", hadSynthesisFlag: false, rawSourcesCount: 0,
      })
    ).not.toThrow();
  });
});

describe("readWriteLog", () => {
  it("returns events newer than the 30-day window", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "recent.md", timestamp: "2026-05-06T10:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const events = readWriteLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events.map((e) => e.page)).toEqual(["recent.md"]);
  });

  it("filters out entries older than 30 days", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "old.md", timestamp: "2026-01-01T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "new.md", timestamp: "2026-05-05T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const events = readWriteLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(events.map((e) => e.page)).toEqual(["new.md"]);
  });

  it("skips malformed JSON lines without throwing", () => {
    mkdirSync(evidenceDir(workspace), { recursive: true });
    writeFileSync(
      writeLogPath(workspace),
      `{"page": "ok.md", "timestamp": "2026-05-06T10:00:00.000Z", "hadSynthesisFlag": false, "rawSourcesCount": 0}\nthis is not json\n{"page": "ok2.md", "timestamp": "2026-05-06T11:00:00.000Z", "hadSynthesisFlag": false, "rawSourcesCount": 0}\n`,
    );
    const events = readWriteLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events.map((e) => e.page)).toEqual(["ok.md", "ok2.md"]);
  });
});

describe("rotateEventLog", () => {
  it("drops entries older than 30 days", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "old.md", timestamp: "2025-01-01T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "new.md", timestamp: "2026-05-05T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const result = rotateEventLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(result.entriesBefore).toBe(2);
    expect(result.entriesAfter).toBe(1);
    const remaining = readFileSync(writeLogPath(workspace), "utf-8");
    expect(remaining).toContain("new.md");
    expect(remaining).not.toContain("old.md");
  });

  it("returns zero counts when no log file exists", () => {
    const result = rotateEventLog(workspace);
    expect(result).toEqual({ entriesBefore: 0, entriesAfter: 0, bytesAfter: 0 });
  });

  it("drops oldest entries when total exceeds size cap", () => {
    // Synthetic: write a 12 MB log — well over the 10 MB cap.
    mkdirSync(evidenceDir(workspace), { recursive: true });
    const eventLine = (i: number, dateOffsetSec: number) => {
      const ts = new Date(Date.now() - dateOffsetSec * 1000).toISOString();
      // Pad page name so each line is ~12 KB; we'll need ~1000 lines for 12 MB.
      const padding = "x".repeat(11900);
      return JSON.stringify({
        page: `p${i}-${padding}.md`,
        timestamp: ts,
        hadSynthesisFlag: false,
        rawSourcesCount: 0,
      });
    };
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(eventLine(i, 1000 - i)); // older entries first
    }
    writeFileSync(writeLogPath(workspace), lines.join("\n") + "\n");
    expect(statSync(writeLogPath(workspace)).size).toBeGreaterThan(10 * 1024 * 1024);

    const result = rotateEventLog(workspace);
    expect(result.bytesAfter).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(result.entriesAfter).toBeLessThan(1000);
    // Newest entries must be retained — the last one had dateOffsetSec=1.
    const remaining = readFileSync(writeLogPath(workspace), "utf-8");
    expect(remaining).toContain("p999-");
  });
});

describe("summarizeLastWeek", () => {
  it("counts only events within the past 7 days", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    appendUnsupportedWriteEvent(workspace, {
      page: "in.md", timestamp: "2026-05-04T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "out.md", timestamp: "2026-04-20T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    expect(summarizeLastWeek(workspace, now).unsupportedCount).toBe(1);
  });

  it("returns zero when no log file exists", () => {
    expect(summarizeLastWeek(workspace).unsupportedCount).toBe(0);
  });
});
