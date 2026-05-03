import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { traceVariable, extractDataflowEdges } from "../variable-tracer.js";

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
