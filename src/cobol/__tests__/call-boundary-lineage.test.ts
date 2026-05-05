import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import { buildCallBoundLineage } from "../call-boundary-lineage.js";

function model(source: string, filename: string) {
  return extractModel(parse(source, filename));
}

const callerWithGroup = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-CUSTOMER-REC.
           05  WS-CUST-ID    PIC X(10).
           05  WS-CUST-NAME  PIC X(30).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-CUSTOMER-REC.
           STOP RUN.
`;

const calleeWithLinkageGroup = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-CUSTOMER-REC.
           05  LK-CUST-ID    PIC X(10).
           05  LK-CUST-NAME  PIC X(30).
       PROCEDURE DIVISION USING LK-CUSTOMER-REC.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;

describe("buildCallBoundLineage", () => {
  it("links caller WS group record to callee LINKAGE group record at matching positions", () => {
    const lineage = buildCallBoundLineage([
      model(callerWithGroup, "CALLER.cbl"),
      model(calleeWithLinkageGroup, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.callSites).toBe(1);
    expect(lineage!.summary.pairs).toBe(1);

    const entry = lineage!.entries[0];
    expect(entry.confidence).toBe("deterministic");
    expect(entry.position).toBe(0);
    expect(entry.caller.programId).toBe("program:CALLER");
    expect(entry.caller.fieldName).toBe("WS-CUSTOMER-REC");
    expect(entry.callee.programId).toBe("program:CALLEE");
    expect(entry.callee.fieldName).toBe("LK-CUSTOMER-REC");
    expect(entry.evidence.shapeMatch).toBe("both-group");
    expect(entry.evidence.levelMatch).toBe(true);
  });

  it("links matching scalar fields when both have the same PIC", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-AMT             PIC 9(9)V99.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-AMT.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-AMT             PIC 9(9)V99.
       PROCEDURE DIVISION USING LK-AMT.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.entries[0].evidence.shapeMatch).toBe("scalar-match");
    expect(lineage!.entries[0].evidence.pictureMatch).toBe(true);
  });

  it("emits multiple entries when CALL passes multiple positional args", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A.
           05  WS-A-FLD       PIC X(5).
       01  WS-B.
           05  WS-B-FLD       PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-A WS-B.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-A.
           05  LK-A-FLD       PIC X(5).
       01  LK-B.
           05  LK-B-FLD       PIC X(5).
       PROCEDURE DIVISION USING LK-A LK-B.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.entries.map((e) => [e.position, e.caller.fieldName, e.callee.fieldName])).toEqual([
      [0, "WS-A", "LK-A"],
      [1, "WS-B", "LK-B"],
    ]);
  });

  it("does not emit entries when USING arity differs from LINKAGE arity", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A               PIC X(5).
       01  WS-B               PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-A WS-B.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-A               PIC X(5).
       PROCEDURE DIVISION USING LK-A.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not emit entries when scalar PICs differ", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-FLD             PIC X(10).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-FLD.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-FLD             PIC 9(8).
       PROCEDURE DIVISION USING LK-FLD.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not emit entries when one side is a group and the other is a scalar", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-REC.
           05  WS-FLD         PIC X(10).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-REC.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-REC             PIC X(10).
       PROCEDURE DIVISION USING LK-REC.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not emit entries when callee is unresolved (no parsed program with that name)", () => {
    const lineage = buildCallBoundLineage([
      model(callerWithGroup, "CALLER.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not emit entries for dynamic CALL where target is a variable", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-PROG-NAME       PIC X(8).
       01  WS-A.
           05  WS-FLD         PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL WS-PROG-NAME USING WS-A.
           STOP RUN.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(calleeWithLinkageGroup, "CALLEE.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not emit entries when caller's USING arg is not a top-level data item", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-OUTER.
           05  WS-INNER       PIC X(10).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-INNER.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-FLD             PIC X(10).
       PROCEDURE DIVISION USING LK-FLD.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not emit entries when CALL has no USING clause", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE".
           STOP RUN.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(calleeWithLinkageGroup, "CALLEE.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("returns null when fewer than two parsed programs are provided", () => {
    expect(buildCallBoundLineage([model(callerWithGroup, "CALLER.cbl")])).toBeNull();
  });
});
