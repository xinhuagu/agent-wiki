import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { traceVariable } from "../variable-tracer.js";

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
