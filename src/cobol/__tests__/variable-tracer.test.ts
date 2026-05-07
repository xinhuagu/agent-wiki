import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { traceVariable, extractDataflowEdges, extractCallEdges } from "../variable-tracer.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("COBOL variable tracer", () => {
  const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");

  it("traces WS-EOF-FLAG references", () => {
    const refs = traceVariable(ast, "WS-EOF-FLAG");
    expect(refs.length).toBeGreaterThanOrEqual(1);
    // MOVE "Y" TO WS-EOF-FLAG → write
    const writeRef = refs.find((r) => r.access === "write");
    expect(writeRef).toBeDefined();
    expect(writeRef!.verb).toBe("MOVE");
  });

  it("traces WS-TOTAL-SALARY references", () => {
    const refs = traceVariable(ast, "WS-TOTAL-SALARY");
    expect(refs.length).toBeGreaterThanOrEqual(1);
    // ADD EMP-SALARY TO WS-TOTAL-SALARY → both (TO target)
    const addRef = refs.find((r) => r.verb === "ADD");
    expect(addRef).toBeDefined();
    expect(addRef!.access).toBe("both");
  });

  it("traces EMP-SALARY references", () => {
    const refs = traceVariable(ast, "EMP-SALARY");
    expect(refs.length).toBeGreaterThanOrEqual(2);
    // ADD EMP-SALARY TO ... → read (before TO)
    const addRef = refs.find((r) => r.verb === "ADD");
    expect(addRef).toBeDefined();
    expect(addRef!.access).toBe("read");
    // CALL "CALC-TAX" USING EMP-SALARY ... → both
    const callRef = refs.find((r) => r.verb === "CALL");
    expect(callRef).toBeDefined();
    expect(callRef!.access).toBe("both");
  });

  it("traces WS-EMP-COUNT references across sections", () => {
    const refs = traceVariable(ast, "WS-EMP-COUNT");
    const sections = [...new Set(refs.map((r) => r.section))];
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });

  it("classifies COMPUTE target as write", () => {
    const refs = traceVariable(ast, "WS-AVG-SALARY");
    const computeRef = refs.find((r) => r.verb === "COMPUTE");
    expect(computeRef).toBeDefined();
    expect(computeRef!.access).toBe("write");
  });

  it("classifies DISPLAY operands as read", () => {
    const refs = traceVariable(ast, "WS-EMP-COUNT");
    const displayRef = refs.find((r) => r.verb === "DISPLAY");
    expect(displayRef).toBeDefined();
    expect(displayRef!.access).toBe("read");
  });

  it("returns empty for non-existent variable", () => {
    const refs = traceVariable(ast, "DOES-NOT-EXIST");
    expect(refs).toEqual([]);
  });
});

describe("COBOL extractDataflowEdges", () => {
  const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");
  const edges = extractDataflowEdges(ast);

  it("emits MOVE edge: field-to-field", () => {
    const minimalSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TEST.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 SRC-FIELD PIC 9(5).
       01 DST-FIELD PIC 9(5).
       PROCEDURE DIVISION.
       P1.
           MOVE SRC-FIELD TO DST-FIELD.
           STOP RUN.
    `;
    const minAst = parse(minimalSrc, "TEST.cbl");
    const minEdges = extractDataflowEdges(minAst);
    const edge = minEdges.find((e) => e.from === "SRC-FIELD" && e.to === "DST-FIELD");
    expect(edge).toBeDefined();
    expect(edge!.via).toBe("MOVE");
  });


  it("emits ADD edge: EMP-SALARY → WS-TOTAL-SALARY", () => {
    const edge = edges.find((e) => e.from === "EMP-SALARY" && e.to === "WS-TOTAL-SALARY");
    expect(edge).toBeDefined();
    expect(edge!.via).toBe("ADD");
  });

  it("emits COMPUTE edges: WS-TOTAL-SALARY and WS-EMP-COUNT → WS-AVG-SALARY", () => {
    const toAvg = edges.filter((e) => e.to === "WS-AVG-SALARY" && e.via === "COMPUTE");
    const froms = toAvg.map((e) => e.from).sort();
    expect(froms).toContain("WS-TOTAL-SALARY");
    expect(froms).toContain("WS-EMP-COUNT");
  });

  it("does not emit self-edges", () => {
    const selfEdges = edges.filter((e) => e.from === e.to);
    expect(selfEdges).toHaveLength(0);
  });

  it("does not emit edges for literal-only MOVE (MOVE 'Y' TO WS-EOF-FLAG)", () => {
    const fromLiteral = edges.filter((e) => e.to === "WS-EOF-FLAG" && e.via === "MOVE");
    expect(fromLiteral).toHaveLength(0);
  });

  it("records procedure and section for each edge", () => {
    const addEdge = edges.find((e) => e.via === "ADD" && e.to === "WS-TOTAL-SALARY");
    expect(addEdge).toBeDefined();
    expect(addEdge!.procedure).toBeTruthy();
    expect(addEdge!.section).toBeTruthy();
  });

  it("records correct line numbers", () => {
    const addEdge = edges.find((e) => e.from === "EMP-SALARY" && e.to === "WS-TOTAL-SALARY");
    expect(addEdge).toBeDefined();
    expect(addEdge!.line).toBeGreaterThan(0);
  });

  it("does not shatter multi-word literals into pseudo-variables (#20 phase B)", () => {
    // Pre-fix: lexer emitted `"DAS IST EIN TEST"` as one LITERAL token,
    // parser joined into rawText with spaces, dataflow re-split on
    // whitespace producing phantom `IST` / `EIN` / `TEST` reads. Phase B
    // iterates typed tokens and skips whole LITERALs.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. STR-LIT.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-MSG    PIC X(40).
       PROCEDURE DIVISION.
       A100.
           MOVE "DAS IST EIN TEST" TO WS-MSG.
           STOP RUN.
`;
    const ast = parse(source, "STR-LIT.cbl");
    const literalEdges = extractDataflowEdges(ast);
    // No edges sourced from any literal-internal word.
    const phantoms = literalEdges.filter(
      (e) => e.from === "DAS" || e.from === "IST" || e.from === "EIN" || e.from === "TEST",
    );
    expect(phantoms).toHaveLength(0);
    // The MOVE-from-literal is correctly classified as no-edge (target
    // gets no incoming dataflow because the source is a literal).
    expect(literalEdges.filter((e) => e.to === "WS-MSG")).toHaveLength(0);

    // Verify the underlying contract: the parser preserves the literal's
    // internal whitespace as a single token's value. This is the
    // representation invariant `StatementNode.tokens` JSDoc claims; if a
    // future lexer change strips internal spaces, this fails before the
    // higher-level "no phantoms" assertion masks the regression.
    const moveStmt = ast.divisions
      .flatMap((d) => d.sections)
      .flatMap((s) => s.paragraphs)
      .flatMap((p) => p.statements)
      .find((s) => s.verb === "MOVE");
    expect(moveStmt).toBeDefined();
    const literalToken = moveStmt!.tokens.find((t) => t.type === "LITERAL");
    expect(literalToken?.value).toBe('"DAS IST EIN TEST"');
  });

  it("collapses qualified references into one edge: MOVE A OF G1 TO B OF G2 (#20 phase C)", () => {
    // Pre-fix: lexer emitted OF as a typed token but dataflow re-split
    // rawText, treating OF as a "variable" token. With OF passing the
    // identifier check, MOVE A OF GROUP-1 TO B OF GROUP-2 produced a
    // 2x2 Cartesian (A→B, A→GROUP-2, GROUP-1→B, GROUP-1→GROUP-2) plus
    // OF→OF self-edges. Phase C: OF/IN are keywords, and adjacent
    // IDENT OF IDENT collapses to one qualified node matching
    // traceVariable's existing format.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. QUAL-MV.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  GROUP-1.
           05  A      PIC X(4).
       01  GROUP-2.
           05  B      PIC X(4).
       PROCEDURE DIVISION.
       A100.
           MOVE A OF GROUP-1 TO B OF GROUP-2.
           STOP RUN.
`;
    const ast = parse(source, "QUAL-MV.cbl");
    const moveEdges = extractDataflowEdges(ast).filter((e) => e.via === "MOVE");
    // Exactly one edge between the qualified names.
    expect(moveEdges).toHaveLength(1);
    expect(moveEdges[0].from).toBe("A OF GROUP-1");
    expect(moveEdges[0].to).toBe("B OF GROUP-2");
    // Critically, no separate edges from/to the parent group names.
    const gParent = extractDataflowEdges(ast).filter(
      (e) => e.from === "GROUP-1" || e.to === "GROUP-2" || e.from === "OF" || e.to === "OF",
    );
    expect(gParent).toHaveLength(0);
  });

  it("does not surface bare OF/IN as a dataflow variable (#20 phase C keywords)", () => {
    // Spot check: even without qualifier collapse firing (e.g., a non-
    // canonical OF in some bizarre fixture), OF / IN should not show up
    // as edge endpoints because they're now in NON_VARIABLE_KEYWORDS.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. NO-OF.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  X    PIC X(4).
       01  Y    PIC X(4).
       PROCEDURE DIVISION.
       A100.
           MOVE X TO Y.
           STOP RUN.
`;
    const ast = parse(source, "NO-OF.cbl");
    const allEdges = extractDataflowEdges(ast);
    expect(allEdges.some((e) => e.from === "OF" || e.to === "OF")).toBe(false);
    expect(allEdges.some((e) => e.from === "IN" || e.to === "IN")).toBe(false);
  });

  it("collapses multi-level qualifiers: A OF B OF C TO D produces one chained node (#20 phase C)", () => {
    // COBOL allows arbitrary qualification depth. The while-loop
    // collapse must capture all OF/IN chain segments — without it, only
    // the innermost OF would be folded and outer parents would surface
    // as phantom variables.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. DEEP-Q.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  C.
           05  B.
               10  A      PIC X(4).
       01  D                  PIC X(4).
       PROCEDURE DIVISION.
       A100.
           MOVE A OF B OF C TO D.
           STOP RUN.
`;
    const ast = parse(source, "DEEP-Q.cbl");
    const moveEdges = extractDataflowEdges(ast).filter((e) => e.via === "MOVE");
    expect(moveEdges).toHaveLength(1);
    expect(moveEdges[0].from).toBe("A OF B OF C");
    expect(moveEdges[0].to).toBe("D");
    // Critically, no phantom edge from the outermost qualifier `C`.
    const phantomC = extractDataflowEdges(ast).filter(
      (e) => e.from === "C" || e.from === "B",
    );
    expect(phantomC).toHaveLength(0);
  });

  it("STRING WITH POINTER classifies the pointer var as both read and written (#20 phase D)", () => {
    // Phase D: WITH POINTER var is read-and-written each iteration. The
    // POINTER marker switches access to "both" so the pointer var is
    // classified r/w. WS-PTR should appear as a self-edge candidate
    // (reads + writes), so non-self edges include WS-PTR on both sides.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. STR-PTR.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-SRC    PIC X(8).
       01  WS-RES    PIC X(40).
       01  WS-PTR    PIC 9(4) COMP.
       PROCEDURE DIVISION.
       A100.
           STRING WS-SRC INTO WS-RES WITH POINTER WS-PTR.
           STOP RUN.
`;
    const ast = parse(source, "STR-PTR.cbl");
    const stringEdges = extractDataflowEdges(ast).filter((e) => e.via === "STRING");
    // Pointer var participates as both read and write — appears in edges
    // both as `from` and as `to`.
    const ptrAsFrom = stringEdges.some((e) => e.from === "WS-PTR");
    const ptrAsTo = stringEdges.some((e) => e.to === "WS-PTR");
    expect(ptrAsFrom).toBe(true);
    expect(ptrAsTo).toBe(true);
    // POINTER itself is not an edge endpoint (it's now a marker keyword).
    expect(stringEdges.some((e) => e.from === "POINTER" || e.to === "POINTER")).toBe(false);
    // Known-noise: the simple Cartesian model produces WS-SRC → WS-PTR
    // and WS-PTR → WS-RES even though semantically the pointer doesn't
    // dataflow to/from source/result. Eliminating these requires a
    // per-clause state machine — out of scope for #20 phase D, see the
    // PR description's "Known limitation" section. Asserting the noise
    // edges exist locks the trade-off so a future state-machine fix
    // explicitly removes them.
    expect(stringEdges.some((e) => e.from === "WS-SRC" && e.to === "WS-PTR")).toBe(true);
    expect(stringEdges.some((e) => e.from === "WS-PTR" && e.to === "WS-RES")).toBe(true);
  });

  it("UNSTRING: DELIMITER IN <var> and COUNT IN <var> are writes, not reads (#20 phase D)", () => {
    // UNSTRING-specific markers: `DELIMITER IN <var>` captures which
    // delimiter matched (write to var); `COUNT IN <var>` captures how
    // many chars matched (write). Pre-fix these were classified by the
    // surrounding mode (often read) so the captures appeared as
    // phantom inputs to the UNSTRING dataflow.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. UNS-CAP.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-INPUT     PIC X(40).
       01  WS-DEL       PIC X(1).
       01  WS-PART1     PIC X(20).
       01  WS-WHICH-DEL PIC X(1).
       01  WS-LEN       PIC 9(4).
       PROCEDURE DIVISION.
       A100.
           UNSTRING WS-INPUT DELIMITED BY WS-DEL
             INTO WS-PART1 DELIMITER IN WS-WHICH-DEL COUNT IN WS-LEN.
           STOP RUN.
`;
    const ast = parse(source, "UNS-CAP.cbl");
    const unstringEdges = extractDataflowEdges(ast).filter((e) => e.via === "UNSTRING");
    // Capture vars receive output, so they appear as `to`, not `from`.
    expect(unstringEdges.some((e) => e.to === "WS-WHICH-DEL")).toBe(true);
    expect(unstringEdges.some((e) => e.to === "WS-LEN")).toBe(true);
    // No clause keyword surfaces as an endpoint.
    for (const kw of ["DELIMITED", "DELIMITER", "COUNT", "BY", "IN"]) {
      expect(unstringEdges.some((e) => e.from === kw || e.to === kw)).toBe(false);
    }
  });

  it("INSPECT: BEFORE/AFTER INITIAL <delim> classifies delim as read (#20 phase D)", () => {
    // INSPECT TALLYING / REPLACING with a BEFORE/AFTER INITIAL clause:
    // the delim var is a read (it's a literal-or-var pattern to match,
    // not a write target). Pre-fix the surrounding mode (TALLYING set
    // to write) would have leaked into the delim classification.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. INS-BA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-INPUT   PIC X(40).
       01  WS-COUNT   PIC 9(4).
       01  WS-DELIM   PIC X(1).
       PROCEDURE DIVISION.
       A100.
           INSPECT WS-INPUT TALLYING WS-COUNT FOR ALL "X"
             BEFORE INITIAL WS-DELIM.
           STOP RUN.
`;
    const ast = parse(source, "INS-BA.cbl");
    const inspectEdges = extractDataflowEdges(ast).filter((e) => e.via === "INSPECT");
    // WS-COUNT is the tally write target.
    expect(inspectEdges.some((e) => e.to === "WS-COUNT")).toBe(true);
    // WS-DELIM (the delim) is read, never written.
    expect(inspectEdges.some((e) => e.to === "WS-DELIM")).toBe(false);
    expect(inspectEdges.some((e) => e.from === "WS-DELIM")).toBe(true);
    // INITIAL / BEFORE / AFTER never as endpoints.
    for (const kw of ["INITIAL", "BEFORE", "AFTER"]) {
      expect(inspectEdges.some((e) => e.from === kw || e.to === kw)).toBe(false);
    }
  });

  it("STRING DELIMITED clause keywords are not treated as variables (#20 phase D)", () => {
    // Phase C+D combined: STRING SRC DELIMITED BY DELIM INTO TARGET.
    // The DELIMITED / BY / WITH / OVERFLOW clause keywords were
    // previously surfaced as phantom variables. Now they're keyword-
    // filtered (Phase C) and also act as access-mode markers (Phase D).
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. STR-DEL.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-SRC      PIC X(8).
       01  WS-DELIM    PIC X(1).
       01  WS-RES      PIC X(40).
       PROCEDURE DIVISION.
       A100.
           STRING WS-SRC DELIMITED BY WS-DELIM INTO WS-RES.
           STOP RUN.
`;
    const ast = parse(source, "STR-DEL.cbl");
    const stringEdges = extractDataflowEdges(ast).filter((e) => e.via === "STRING");
    // No edges with clause keywords as endpoints.
    const phantomKeywords = ["DELIMITED", "BY", "WITH", "POINTER", "OVERFLOW"];
    for (const kw of phantomKeywords) {
      expect(stringEdges.some((e) => e.from === kw || e.to === kw)).toBe(false);
    }
  });

  it("typed-token path matches existing numeric-prefix filtering for NUMERIC tokens", () => {
    // Numeric literals (`12345`) were already filtered pre-Phase-B by
    // `isDataflowVariable`'s `^[0-9]` check, so this case isn't a new
    // win — but the typed-token migration introduces a second filter
    // path (`t.type === "NUMERIC"` short-circuit). This test locks the
    // two paths agree, so a future cleanup that removes `^[0-9]` (now
    // redundant with type checking) doesn't regress numeric handling.
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. NUM-LIT.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-COUNT  PIC 9(4).
       PROCEDURE DIVISION.
       A100.
           MOVE 12345 TO WS-COUNT.
           STOP RUN.
`;
    const ast = parse(source, "NUM-LIT.cbl");
    const numericEdges = extractDataflowEdges(ast);
    const fromNumber = numericEdges.filter((e) => /^[0-9]/.test(e.from));
    expect(fromNumber).toHaveLength(0);
  });
});

describe("COBOL extractDataflowEdges — EXEC SQL host variables", () => {
  const ast = parse(fixture("CUSTOMER-DB2.cbl"), "CUSTOMER-DB2.cbl");
  const edges = extractDataflowEdges(ast);

  it("SELECT INTO: emits SQL:table → write-host-var edge", () => {
    const edge = edges.find(
      (e) => e.from === "SQL:CUSTOMER-TABLE" && e.to === "WS-CUST-NAME" && e.via === "EXEC SQL SELECT",
    );
    expect(edge).toBeDefined();
  });

  it("SELECT INTO: emits read-host-var → SQL:table edge for WHERE vars", () => {
    const edge = edges.find(
      (e) => e.from === "WS-CUST-ID" && e.to === "SQL:CUSTOMER-TABLE" && e.via === "EXEC SQL SELECT",
    );
    expect(edge).toBeDefined();
  });

  it("SELECT INTO: all INTO vars get write edges from SQL table", () => {
    const writeEdges = edges.filter(
      (e) => e.from === "SQL:CUSTOMER-TABLE" && e.via === "EXEC SQL SELECT",
    );
    const targets = writeEdges.map((e) => e.to).sort();
    expect(targets).toContain("WS-CUST-NAME");
    expect(targets).toContain("WS-CUST-BALANCE");
  });

  it("UPDATE: emits host-var → SQL:table edges", () => {
    const edge = edges.find(
      (e) => e.from === "WS-NEW-BALANCE" && e.to === "SQL:CUSTOMER-TABLE" && e.via === "EXEC SQL UPDATE",
    );
    expect(edge).toBeDefined();
  });

  it("INSERT: emits host-var → SQL:table edges", () => {
    const edge = edges.find(
      (e) => e.from === "WS-CUST-NAME" && e.to === "SQL:CUSTOMER-TABLE" && e.via === "EXEC SQL INSERT",
    );
    expect(edge).toBeDefined();
  });

  it("populates procedure and section for SQL edges", () => {
    const edge = edges.find((e) => e.via === "EXEC SQL SELECT");
    expect(edge).toBeDefined();
    expect(edge!.procedure).toBeTruthy();
    expect(edge!.section).toBeTruthy();
  });

  it("FETCH INTO: emits SQL:cursor → write-host-var edges using cursor name", () => {
    const fetchSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. FETCHTEST.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-EMP-ID   PIC X(10).
       01 WS-EMP-NAME PIC X(50).
       PROCEDURE DIVISION.
       FETCH-DATA.
           EXEC SQL
               FETCH EMP-CURSOR
                INTO :WS-EMP-ID, :WS-EMP-NAME
           END-EXEC.
           GOBACK.
    `;
    const fetchAst = parse(fetchSrc, "FETCHTEST.cbl");
    const fetchEdges = extractDataflowEdges(fetchAst);
    const idEdge = fetchEdges.find(
      (e) => e.from === "SQL:EMP-CURSOR" && e.to === "WS-EMP-ID" && e.via === "EXEC SQL FETCH",
    );
    expect(idEdge).toBeDefined();
    const nameEdge = fetchEdges.find(
      (e) => e.from === "SQL:EMP-CURSOR" && e.to === "WS-EMP-NAME",
    );
    expect(nameEdge).toBeDefined();
  });
});

describe("COBOL extractCallEdges", () => {
  const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");
  const edges = extractCallEdges(ast);

  it("emits param → program edge for each USING variable", () => {
    // CALL "CALC-TAX" USING EMP-SALARY WS-TAX-AMOUNT
    const salaryEdge = edges.find(
      (e) => e.from === "EMP-SALARY" && e.to === "CALC-TAX" && e.via === "CALL",
    );
    expect(salaryEdge).toBeDefined();
    const taxEdge = edges.find((e) => e.from === "WS-TAX-AMOUNT" && e.to === "CALC-TAX");
    expect(taxEdge).toBeDefined();
  });

  it("handles multiple CALL statements", () => {
    // CALL "PRINT-REPORT" USING WS-TOTALS
    const reportEdge = edges.find(
      (e) => e.to === "PRINT-REPORT" && e.via === "CALL",
    );
    expect(reportEdge).toBeDefined();
  });

  it("populates procedure, section, and line for call edges", () => {
    const edge = edges.find((e) => e.to === "CALC-TAX");
    expect(edge).toBeDefined();
    expect(edge!.procedure).toBeTruthy();
    expect(edge!.section).toBeTruthy();
    expect(edge!.line).toBeGreaterThan(0);
  });

  it("returns empty for program with no CALL statements", () => {
    const noCallSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. NOCALL.
       PROCEDURE DIVISION.
       MAIN.
           MOVE 1 TO WS-X.
           STOP RUN.
    `;
    const noCallAst = parse(noCallSrc, "NOCALL.cbl");
    expect(extractCallEdges(noCallAst)).toHaveLength(0);
  });

  it("ignores BY REFERENCE / BY CONTENT modifiers", () => {
    const byRefSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BYREF.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-A PIC X.
       01 WS-B PIC X.
       PROCEDURE DIVISION.
       MAIN.
           CALL "SUB" USING BY REFERENCE WS-A BY CONTENT WS-B.
           STOP RUN.
    `;
    const byRefAst = parse(byRefSrc, "BYREF.cbl");
    const byRefEdges = extractCallEdges(byRefAst);
    expect(byRefEdges.find((e) => e.from === "WS-A")).toBeDefined();
    expect(byRefEdges.find((e) => e.from === "WS-B")).toBeDefined();
    expect(byRefEdges.find((e) => e.from === "REFERENCE")).toBeUndefined();
    expect(byRefEdges.find((e) => e.from === "CONTENT")).toBeUndefined();
  });

  it("returns empty for CALL without USING clause", () => {
    const noUsingSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. NOUSING.
       PROCEDURE DIVISION.
       MAIN.
           CALL "PROG-B".
           STOP RUN.
    `;
    const noUsingAst = parse(noUsingSrc, "NOUSING.cbl");
    expect(extractCallEdges(noUsingAst)).toHaveLength(0);
  });

  it("dynamic CALL: uses variable name as target program node", () => {
    // CALL WS-PROG-NAME USING WS-PARM — target is the variable holding the program name
    const dynSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. DYNCALL.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PROG-NAME PIC X(8).
       01 WS-PARM      PIC X(10).
       PROCEDURE DIVISION.
       MAIN.
           CALL WS-PROG-NAME USING WS-PARM.
           STOP RUN.
    `;
    const dynAst = parse(dynSrc, "DYNCALL.cbl");
    const dynEdges = extractCallEdges(dynAst);
    // Target is the literal variable name — cross-program resolution is out of scope
    const edge = dynEdges.find((e) => e.from === "WS-PARM" && e.to === "WS-PROG-NAME");
    expect(edge).toBeDefined();
    expect(edge!.via).toBe("CALL");
  });
});
