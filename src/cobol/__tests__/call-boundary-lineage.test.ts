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

    const record = lineage!.entries.find((e) => e.caller.fieldName === "WS-CUSTOMER-REC");
    expect(record).toBeDefined();
    expect(record!.confidence).toBe("deterministic");
    expect(record!.position).toBe(0);
    expect(record!.caller.programId).toBe("program:CALLER");
    expect(record!.caller.qualifiedName).toBe("WS-CUSTOMER-REC");
    expect(record!.callee.programId).toBe("program:CALLEE");
    expect(record!.callee.qualifiedName).toBe("LK-CUSTOMER-REC");
    expect(record!.evidence.shapeMatch).toBe("both-group");
    expect(record!.evidence.levelMatch).toBe(true);
    expect(record!.evidence.nameSuffixMatch).toBe(true);
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
    const records = lineage!.entries.filter((e) => e.caller.qualifiedName === e.caller.fieldName);
    expect(records.map((e) => [e.position, e.caller.fieldName, e.callee.fieldName])).toEqual([
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

  it("descends into matching group children with deterministic confidence when names align", () => {
    const lineage = buildCallBoundLineage([
      model(callerWithGroup, "CALLER.cbl"),
      model(calleeWithLinkageGroup, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const cust = lineage!.entries.find(
      (e) => e.caller.qualifiedName === "WS-CUSTOMER-REC.WS-CUST-ID",
    );
    expect(cust).toBeDefined();
    expect(cust!.callee.qualifiedName).toBe("LK-CUSTOMER-REC.LK-CUST-ID");
    expect(cust!.confidence).toBe("deterministic");
    expect(cust!.evidence.nameSuffixMatch).toBe(true);
    expect(cust!.evidence.shapeMatch).toBe("scalar-match");
    expect(cust!.position).toBe(0);

    const name = lineage!.entries.find(
      (e) => e.caller.qualifiedName === "WS-CUSTOMER-REC.WS-CUST-NAME",
    );
    expect(name).toBeDefined();
    expect(name!.callee.qualifiedName).toBe("LK-CUSTOMER-REC.LK-CUST-NAME");
    expect(name!.confidence).toBe("deterministic");
  });

  it("downgrades child entries to high when structure matches but name suffix differs", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-REC.
           05  WS-FOO         PIC X(5).
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
       01  LK-REC.
           05  COMPLETELY-OTHER PIC X(5).
       PROCEDURE DIVISION USING LK-REC.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const record = lineage!.entries.find((e) => e.caller.fieldName === "WS-REC");
    expect(record!.confidence).toBe("deterministic");

    const child = lineage!.entries.find((e) => e.caller.fieldName === "WS-FOO");
    expect(child).toBeDefined();
    expect(child!.callee.fieldName).toBe("COMPLETELY-OTHER");
    expect(child!.confidence).toBe("high");
    expect(child!.evidence.nameSuffixMatch).toBe(false);
    expect(child!.rationale).toContain("name suffix differs");
  });

  it("descends through nested groups maintaining qualified path on both sides", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-OUTER.
           05  WS-MID.
               10  WS-LEAF    PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-OUTER.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-OUTER.
           05  LK-MID.
               10  LK-LEAF    PIC X(5).
       PROCEDURE DIVISION USING LK-OUTER.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const leaf = lineage!.entries.find((e) => e.caller.fieldName === "WS-LEAF");
    expect(leaf).toBeDefined();
    expect(leaf!.caller.qualifiedName).toBe("WS-OUTER.WS-MID.WS-LEAF");
    expect(leaf!.callee.qualifiedName).toBe("LK-OUTER.LK-MID.LK-LEAF");
    expect(leaf!.evidence.shapeMatch).toBe("scalar-match");
    expect(leaf!.confidence).toBe("deterministic");
  });

  it("keeps top-level entry deterministic even when caller and callee names diverge entirely", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-FOO.
           05  WS-FIELD       PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-FOO.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  COMPLETELY-DIFFERENT.
           05  ANOTHER-FIELD  PIC X(5).
       PROCEDURE DIVISION USING COMPLETELY-DIFFERENT.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const record = lineage!.entries.find((e) => e.caller.fieldName === "WS-FOO");
    expect(record!.callee.fieldName).toBe("COMPLETELY-DIFFERENT");
    expect(record!.evidence.nameSuffixMatch).toBe(false);
    expect(record!.confidence).toBe("deterministic");
  });

  it("preserves USAGE on caller and callee participants", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-AMT             PIC 9(8) USAGE COMP-3.
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
       01  LK-AMT             PIC 9(8) USAGE COMP-3.
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
    const entry = lineage!.entries[0];
    expect(entry.caller.usage).toBe("COMP-3");
    expect(entry.callee.usage).toBe("COMP-3");
  });

  it("only emits entries for child positions that exist on both sides when child counts differ", () => {
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-REC.
           05  WS-A           PIC X(5).
           05  WS-B           PIC X(5).
           05  WS-C           PIC X(5).
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
       01  LK-REC.
           05  LK-A           PIC X(5).
           05  LK-B           PIC X(5).
       PROCEDURE DIVISION USING LK-REC.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(callee, "CALLEE.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const childNames = lineage!.entries
      .filter((e) => e.caller.qualifiedName.includes("."))
      .map((e) => e.caller.fieldName)
      .sort();
    expect(childNames).toEqual(["WS-A", "WS-B"]);
  });
});
