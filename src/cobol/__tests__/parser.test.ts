import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("COBOL parser", () => {
  describe("HELLO.cbl", () => {
    const ast = parse(fixture("HELLO.cbl"), "HELLO.cbl");

    it("extracts PROGRAM-ID", () => {
      expect(ast.programId).toBe("HELLO");
    });

    it("finds all four divisions", () => {
      const names = ast.divisions.map((d) => d.name);
      expect(names).toEqual(["IDENTIFICATION", "ENVIRONMENT", "DATA", "PROCEDURE"]);
    });

    it("parses data items in WORKING-STORAGE", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      expect(ws!.dataItems.length).toBeGreaterThanOrEqual(2);
      const nameItem = ws!.dataItems.find((d) => d.name === "WS-NAME");
      expect(nameItem).toBeDefined();
      expect(nameItem!.picture).toMatch(/X\(30\)/i);
    });

    it("parses PROCEDURE DIVISION sections and paragraphs", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      expect(procDiv.sections.length).toBeGreaterThanOrEqual(1);
      const mainSection = procDiv.sections[0];
      expect(mainSection.name).toBe("A000-MAIN");
      expect(mainSection.paragraphs.length).toBeGreaterThanOrEqual(1);
    });

    it("captures statements with verbs", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const stmts = procDiv.sections.flatMap((s) =>
        s.paragraphs.flatMap((p) => p.statements)
      );
      const verbs = stmts.map((s) => s.verb);
      expect(verbs).toContain("MOVE");
      expect(verbs).toContain("DISPLAY");
      expect(verbs).toContain("STOP");
    });
  });

  describe("PAYROLL.cbl", () => {
    const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");

    it("extracts PROGRAM-ID", () => {
      expect(ast.programId).toBe("PAYROLL");
    });

    it("parses FILE SECTION with FD", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const fileSection = dataDivision.sections.find((s) => s.name === "FILE");
      expect(fileSection).toBeDefined();
      expect(fileSection!.fileDefinitions.length).toBe(1);
      expect(fileSection!.fileDefinitions[0].fd).toBe("EMPLOYEE-FILE");
    });

    it("parses nested data items (group structure)", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      const totals = ws!.dataItems.find((d) => d.name === "WS-TOTALS");
      expect(totals).toBeDefined();
      expect(totals!.children.length).toBe(3);
      expect(totals!.children[0].name).toBe("WS-TOTAL-SALARY");
    });

    it("parses 88-level condition names", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      const flags = ws!.dataItems.find((d) => d.name === "WS-FLAGS");
      expect(flags).toBeDefined();
      const eofFlag = flags!.children.find((d) => d.name === "WS-EOF-FLAG");
      expect(eofFlag).toBeDefined();
      // 88-level items should be children of WS-EOF-FLAG
      const conditions = eofFlag!.children.filter((d) => d.level === 88);
      expect(conditions.length).toBe(1);
      expect(conditions[0].name).toBe("EOF-REACHED");
    });

    it("parses 77-level items", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      const level77 = ws!.dataItems.find((d) => d.level === 77);
      expect(level77).toBeDefined();
      expect(level77!.name).toBe("WS-TAX-AMOUNT");
    });

    it("parses multiple PROCEDURE sections", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const sectionNames = procDiv.sections.map((s) => s.name);
      expect(sectionNames).toContain("A000-MAIN");
      expect(sectionNames).toContain("B000-PROCESS");
      expect(sectionNames).toContain("C000-FINALIZE");
    });

    it("captures CALL statements", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const stmts = procDiv.sections.flatMap((s) =>
        s.paragraphs.flatMap((p) => p.statements)
      );
      const calls = stmts.filter((s) => s.verb === "CALL");
      expect(calls.length).toBe(2);
    });

    it("captures PERFORM statements", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const stmts = procDiv.sections.flatMap((s) =>
        s.paragraphs.flatMap((p) => p.statements)
      );
      const performs = stmts.filter((s) => s.verb === "PERFORM");
      expect(performs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("DATE-UTILS.cpy (copybook)", () => {
    const ast = parse(fixture("DATE-UTILS.cpy"), "DATE-UTILS.cpy");

    it("has no PROGRAM-ID", () => {
      expect(ast.programId).toBe("");
    });

    it("creates a synthetic DATA division for standalone data items", () => {
      expect(ast.divisions.length).toBe(1);
      expect(ast.divisions[0].name).toBe("DATA");
    });

    it("parses the top-level 01 group item", () => {
      const items = ast.divisions[0].sections[0].dataItems;
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("WS-DATE-FIELDS");
      expect(items[0].level).toBe(1);
    });

    it("parses nested data items within the copybook", () => {
      const root = ast.divisions[0].sections[0].dataItems[0];
      // 05-level children: WS-CURRENT-DATE, WS-FORMATTED-DATE, WS-DATE-VALID
      expect(root.children.length).toBe(3);
      expect(root.children[0].name).toBe("WS-CURRENT-DATE");
    });

    it("parses deeply nested items (10-level)", () => {
      const currentDate = ast.divisions[0].sections[0].dataItems[0].children[0];
      // 10-level: WS-YEAR, WS-MONTH, WS-DAY
      expect(currentDate.children.length).toBe(3);
      expect(currentDate.children[0].name).toBe("WS-YEAR");
      expect(currentDate.children[0].picture).toMatch(/9\(4\)/i);
    });

    it("parses 88-level conditions in copybook", () => {
      const dateValid = ast.divisions[0].sections[0].dataItems[0].children[2]; // WS-DATE-VALID
      expect(dateValid.name).toBe("WS-DATE-VALID");
      const conditions = dateValid.children.filter((d) => d.level === 88);
      expect(conditions.length).toBe(2);
      expect(conditions[0].name).toBe("DATE-IS-VALID");
      expect(conditions[1].name).toBe("DATE-INVALID");
    });
  });

  describe("listing-extracted copybook with leading header (issue #28)", () => {
    // Compile-listing fragments often carry an 8-ish-line header where text
    // begins at columns other than 7 (here col 15), so the lexer's col-7
    // `*` comment filter doesn't strip it. Pre-fix, parseDataItems() saw a
    // leading IDENTIFIER on peek() and exited immediately — zero data items
    // for an otherwise valid copybook.
    const src = [
      "              Source Listing of SAMPLEREC",
      "              Compiled 2024-01-01",
      "              Library  SAMPLELIB",
      "              Author   EXAMPLE",
      "              =================================",
      "       01  SAMPLE-REC.",
      "           05  SAMPLE-ID    PIC X(8).",
      "           05  SAMPLE-DATA  PIC X(80).",
    ].join("\n");
    const ast = parse(src, "SAMPLEREC.cpy");

    it("creates a synthetic DATA division", () => {
      expect(ast.divisions.length).toBe(1);
      expect(ast.divisions[0].name).toBe("DATA");
    });

    it("parses data items despite the leading non-level header", () => {
      const items = ast.divisions[0].sections[0].dataItems;
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("SAMPLE-REC");
      expect(items[0].level).toBe(1);
      expect(items[0].children.length).toBe(2);
      expect(items[0].children[0].name).toBe("SAMPLE-ID");
      expect(items[0].children[0].picture).toMatch(/X\(8\)/i);
      expect(items[0].children[1].name).toBe("SAMPLE-DATA");
    });
  });

  describe("PROGRAM-ID quoted-literal handling", () => {
    it("strips single quotes around the program name", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. 'MY-PROG'.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const ast = parse(src, "quoted.cbl");
      expect(ast.programId).toBe("MY-PROG");
    });

    it("strips double quotes around the program name", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. "MY-PROG".
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const ast = parse(src, "dq.cbl");
      expect(ast.programId).toBe("MY-PROG");
    });

    it("leaves unquoted PROGRAM-ID identifiers untouched", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PLAIN-PROG.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const ast = parse(src, "plain.cbl");
      expect(ast.programId).toBe("PLAIN-PROG");
    });
  });

  describe("OCCURS clause (#53 — lexer-emitted LEVEL_NUMBER for 1-2 digit counts)", () => {
    // The lexer emits LEVEL_NUMBER for any 1-2 digit number (because data
    // item levels share that lexical shape). Pre-#53 the OCCURS handler
    // only accepted NUMERIC, so the count was lost on 1-2 digit OCCURS
    // clauses AND the next clause (PIC, USAGE, ...) terminated early on
    // the misclassified LEVEL_NUMBER, spawning phantom items. Regression
    // anchors below cover all three shapes the dogfood corpus exercises.
    function dataItems(src: string) {
      const ast = parse(src, "T.cbl");
      const dataDiv = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDiv.sections.find((s) => s.name.includes("WORKING-STORAGE"))!;
      return ws.dataItems;
    }
    // Phantom-item probes walk root + descendants — buildDataHierarchy
    // nests items with `level > parent.level` as children, so a phantom
    // level-N FILLER would land under whichever data item the bug
    // truncated, not at the root.
    function allItems(roots: ReturnType<typeof dataItems>): typeof roots {
      const out: typeof roots = [];
      const walk = (items: typeof roots) => {
        for (const i of items) {
          out.push(i);
          walk(i.children);
        }
      };
      walk(roots);
      return out;
    }
    function prog(body: string): string {
      return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. T.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
${body}
       PROCEDURE DIVISION.
       A. STOP RUN.
`;
    }

    it("captures OCCURS <single-digit-count> TIMES on a group item", () => {
      const items = dataItems(prog(`       01  G.
           02 X OCCURS 2 TIMES.
               03 Y PIC X(5).`));
      const g = items.find((i) => i.name === "G")!;
      const x = g.children.find((c) => c.name === "X")!;
      expect(x.occurs).toBe(2);
      // Child unaffected — no phantom FILLER between X and Y.
      expect(x.children.map((c) => c.name)).toEqual(["Y"]);
    });

    it("captures both OCCURS count and PIC on an inline-table item (1-digit count)", () => {
      const items = dataItems(prog(`       01  T2 OCCURS 5 TIMES PIC X(10).`));
      const t2 = items.find((i) => i.name === "T2")!;
      expect(t2.occurs).toBe(5);
      expect(t2.picture).toBe("X(10)");
      // Pre-fix, parseDataItem terminated at "5" (LEVEL_NUMBER), spawning
      // a phantom level-5 FILLER that buildDataHierarchy nested under T2
      // (level > parent → child). Walk root + descendants to actually
      // catch it.
      expect(allItems(items).find((i) => i.level === 5 && i.name === "FILLER")).toBeUndefined();
    });

    it("captures OCCURS for 3-digit counts (NUMERIC token path)", () => {
      // 3+ digit numbers lex as NUMERIC rather than LEVEL_NUMBER; this
      // is the original-spec path that worked pre-#53.
      const items = dataItems(prog(`       01  T3 OCCURS 100 TIMES PIC 9(4).`));
      const t3 = items.find((i) => i.name === "T3")!;
      expect(t3.occurs).toBe(100);
      expect(t3.picture).toBe("9(4)");
    });

    it("phantom-FILLER probe: `OCCURS 5 TIMES PIC X(10)` does NOT spawn a phantom level-5 FILLER (separate it() so the probe isn't masked by the .toBe(occurs) failure)", () => {
      // Lives in its own it() block because vitest's expect is hard-fail —
      // a phantom-detection assertion positioned after .toBe(occurs) /
      // .toBe(picture) never fires when the bug is back, since those
      // throw first and abort the test. Splitting them out means the
      // phantom walk is genuinely load-bearing.
      const items = dataItems(prog(`       01  T2 OCCURS 5 TIMES PIC X(10).`));
      expect(allItems(items).find((i) => i.level === 5 && i.name === "FILLER")).toBeUndefined();
    });

    it("phantom-FILLER probe: `VALUE 5 PIC 9` does NOT spawn a phantom level-5 FILLER", () => {
      const items = dataItems(prog(`       01  WS-CHOICE VALUE 5 PIC 9.`));
      expect(allItems(items).find((i) => i.level === 5 && i.name === "FILLER")).toBeUndefined();
    });

    it("malformed-input guard: `OCCURS\\n03 Y PIC X(5).` (missing count, OCCURS at line end) does NOT consume Y's level number", () => {
      // Without the same-line guard on the LEVEL_NUMBER acceptance, the
      // OCCURS handler would greedily consume "03" as occurs=3 and
      // orphan the Y data item that should follow. With the guard, the
      // LEVEL_NUMBER on the next line is preserved and Y parses
      // cleanly as a sibling.
      const items = dataItems(prog(`       01  G.
           02 X OCCURS
           03 Y PIC X(5).`));
      const g = items.find((i) => i.name === "G")!;
      const x = g.children.find((c) => c.name === "X")!;
      expect(x.occurs).toBeUndefined();
      // Y survives — depending on the data-hierarchy logic it lands as
      // a child of G (level 3 > level 1 → nested) or under X. Either
      // way it must appear somewhere in the tree.
      expect(allItems(items).find((i) => i.name === "Y")).toBeDefined();
    });

    it("multi-line OCCURS clause: `OCCURS\\n   5 TIMES` (count on next line, but TIMES follows) is recognized", () => {
      // Legal-but-unusual COBOL: count and TIMES on a line after OCCURS.
      // The line-guard would reject `5` (different line), but the
      // lookahead-to-TIMES branch accepts because TIMES proves the `5`
      // is an OCCURS count, not the next data item's level number.
      const items = dataItems(prog(`       01  T2 OCCURS
           5 TIMES PIC X(10).`));
      const t2 = items.find((i) => i.name === "T2")!;
      expect(t2.occurs).toBe(5);
      expect(t2.picture).toBe("X(10)");
    });

    it("malformed-input guard: `VALUE\\n02 Y PIC X.` (missing value, VALUE at line end) does NOT consume Y's level number", () => {
      const items = dataItems(prog(`       01  X PIC 9 VALUE
           02 Y PIC X.`));
      const x = items.find((i) => i.name === "X")!;
      expect(x.value).toBeUndefined();
      expect(allItems(items).find((i) => i.name === "Y")).toBeDefined();
    });

    it("VALUE clause survives a small-integer literal in mid-clause position (same lexer-shape bug class)", () => {
      // `VALUE 5 PIC 9.` — the "5" lexes as LEVEL_NUMBER (in the
      // 1-49 range). Pre-#53, the VALUE handler only accepted
      // LITERAL/NUMERIC/IDENTIFIER, so the value was dropped AND
      // parseDataItem terminated at the LEVEL_NUMBER, dropping the
      // trailing PIC AND spawning a phantom `5 FILLER PIC 9` at the
      // parent level. After accepting LEVEL_NUMBER in the VALUE clause
      // (parallel to the OCCURS fix), all three are captured cleanly.
      const items = dataItems(prog(`       01  WS-CHOICE VALUE 5 PIC 9.`));
      const choice = items.find((i) => i.name === "WS-CHOICE")!;
      expect(choice.value).toBe("5");
      expect(choice.picture).toBe("9");
      // Same phantom-detection caveat as the OCCURS test — walk
      // descendants since buildDataHierarchy would nest the phantom
      // under WS-CHOICE.
      expect(allItems(items).find((i) => i.level === 5 && i.name === "FILLER")).toBeUndefined();
    });
  });
});
