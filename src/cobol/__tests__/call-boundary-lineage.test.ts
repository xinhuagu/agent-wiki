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

  it("emits arity-mismatch diagnostic when USING arity differs from LINKAGE arity", () => {
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

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    expect(lineage!.diagnostics).toHaveLength(1);
    expect(lineage!.diagnostics[0]!.kind).toBe("arity-mismatch");
    expect(lineage!.diagnostics[0]!.target).toBe("CALLEE");
  });

  it("emits shape-mismatch diagnostic when scalar PICs differ", () => {
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

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    expect(lineage!.diagnostics.map((d) => d.kind)).toEqual(["shape-mismatch"]);
  });

  it("emits shape-mismatch diagnostic when one side is a group and the other is a scalar", () => {
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

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    expect(lineage!.diagnostics.map((d) => d.kind)).toEqual(["shape-mismatch"]);
  });

  it("does not emit entries when callee is unresolved (no parsed program with that name)", () => {
    const lineage = buildCallBoundLineage([
      model(callerWithGroup, "CALLER.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("emits dynamic-call diagnostic when CALL target is a variable identifier", () => {
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

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    expect(lineage!.diagnostics.map((d) => d.kind)).toEqual(["dynamic-call"]);
    expect(lineage!.diagnostics[0]!.target).toBe("WS-PROG-NAME");
  });

  it("attaches a weak/inferred envelope to high-confidence entries (name divergence)", () => {
    // Top-level group pair matches deterministically; descended children
    // have divergent names → child entries are confidence: "high" → envelope
    // should be weak/inferred.
    const callerSrc = `
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
    const calleeSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-REC.
           05  LK-COMPLETELY-OTHER-NAME PIC X(5).
       PROCEDURE DIVISION USING LK-REC.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(callerSrc, "CALLER.cbl"),
      model(calleeSrc, "CALLEE.cbl"),
    ]);
    expect(lineage).not.toBeNull();
    const child = lineage!.entries.find((e) => e.confidence === "high");
    expect(child).toBeDefined();
    expect(child!.envelope.confidence).toBe("weak");
    expect(child!.envelope.basis).toBe("inferred");
    expect(child!.envelope.abstain).toBe(false);
  });

  it("attaches an EvidenceEnvelope to each entry derived from confidence tier", () => {
    const callerSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A               PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "CALLEE" USING WS-A.
           STOP RUN.
`;
    const calleeSrc = `
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
      model(callerSrc, "CALLER.cbl"),
      model(calleeSrc, "CALLEE.cbl"),
    ]);
    expect(lineage).not.toBeNull();
    const entry = lineage!.entries[0]!;
    expect(entry.envelope.confidence).toBe("strong");
    expect(entry.envelope.basis).toBe("deterministic");
    expect(entry.envelope.abstain).toBe(false);
    expect(entry.envelope.provenance).toEqual([
      { raw: "CALLER.cbl", line: expect.any(Number) },
      { raw: "CALLEE.cbl" },
    ]);
  });

  it("emits caller-arg-not-top-level diagnostic when USING arg is nested", () => {
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

    expect(lineage).not.toBeNull();
    expect(lineage!.entries).toHaveLength(0);
    expect(lineage!.diagnostics.map((d) => d.kind)).toEqual(["caller-arg-not-top-level"]);
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

  it("classifies CALL of an IBM runtime API as system-call, not unresolved-callee (#26 phase 1)", () => {
    // CALL to an IBM-published runtime (MQ / Language Environment / CICS
    // batch family) shouldn't be reported as a missing user program. The
    // SYSTEM_CALLEES whitelist routes these to a dedicated `system-call`
    // diagnostic so the noise floor stays low and genuine user-program
    // gaps stand out.
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-MQ-HCONN        PIC 9(9).
       01  WS-MQ-OPTIONS      PIC 9(9).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "MQCONN" USING WS-MQ-HCONN WS-MQ-OPTIONS.
           CALL "CEEDATE" USING WS-MQ-HCONN WS-MQ-OPTIONS.
           STOP RUN.
`;
    // Need a second user program in the corpus so the analyzer doesn't
    // bail at the < 2 programs guard.
    const otherUser = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OTHER.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-X       PIC X(8).
       PROCEDURE DIVISION USING LK-X.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(otherUser, "OTHER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const systemCalls = lineage!.diagnostics.filter((d) => d.kind === "system-call");
    expect(systemCalls).toHaveLength(2);
    expect(systemCalls.map((d) => d.target).sort()).toEqual(["CEEDATE", "MQCONN"]);
    // The IBM-API targets do NOT show up as unresolved-callee.
    const unresolved = lineage!.diagnostics.filter((d) => d.kind === "unresolved-callee");
    expect(unresolved.some((d) => d.target === "MQCONN" || d.target === "CEEDATE")).toBe(false);
    // Rationale points the user at the IBM-runtime classification.
    expect(systemCalls[0]!.rationale).toContain("IBM");
    // Summary count is updated.
    expect(lineage!.summary.diagnosticsByKind["system-call"]).toBe(2);
  });

  it("resolves USING arg defined in a COPY'd copybook (#26 phase 3)", () => {
    // Phase 3: parser doesn't inline-expand COPY, so a `01 TEST-RECORD`
    // declared inside a copybook never appears in `caller.dataItems`.
    // Pre-fix the analyzer fired `caller-arg-not-top-level` for every
    // COPY-supplied USING arg. With the copybook fallback, the resolver
    // walks the parsed copybooks the caller COPYs and finds the record.
    const copybook = `
       01  TEST-RECORD.
           05  FIELD-A   PIC X(10).
           05  FIELD-B   PIC 9(5).
`;
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER01.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY TESTREC.
       PROCEDURE DIVISION.
       A100.
           CALL "CALLEE01" USING TEST-RECORD.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE01.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-RECORD.
           05  LK-FIELD-A PIC X(10).
           05  LK-FIELD-B PIC 9(5).
       PROCEDURE DIVISION USING LK-RECORD.
       A100.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(copybook, "TESTREC.cpy"),
      model(caller, "CALLER01.cbl"),
      model(callee, "CALLEE01.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    // No caller-arg-not-top-level diagnostic — copybook fallback resolves it.
    expect(lineage!.diagnostics.some((d) => d.kind === "caller-arg-not-top-level")).toBe(false);
    // Pair succeeds.
    expect(lineage!.entries.length).toBeGreaterThan(0);
    const topPair = lineage!.entries.find((e) => e.position === 0);
    expect(topPair?.caller.fieldName).toBe("TEST-RECORD");
  });

  it("inline data item shadows a same-named copybook item (#26 phase 3 precedence)", () => {
    // Resolution order: caller's own dataItems first, then copybooks.
    // A program declaring `01 TEST-RECORD` inline AND copying a
    // copybook with the same name uses the inline declaration.
    const copybook = `
       01  TEST-RECORD.
           05  CPY-FIELD   PIC X(99).
`;
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER02.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  TEST-RECORD.
           05  WS-FIELD    PIC X(10).
           COPY TESTREC.
       PROCEDURE DIVISION.
       A100.
           CALL "CALLEE02" USING TEST-RECORD.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE02.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-RECORD.
           05  LK-FIELD    PIC X(10).
       PROCEDURE DIVISION USING LK-RECORD.
       A100.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(copybook, "TESTREC.cpy"),
      model(caller, "CALLER02.cbl"),
      model(callee, "CALLEE02.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const topPair = lineage!.entries.find((e) => e.position === 0);
    // The pair child count reflects the INLINE TEST-RECORD (1 child:
    // WS-FIELD), not the copybook's TEST-RECORD (1 child: CPY-FIELD).
    // Since both have 1 child the count is the same; what differs is
    // which child name surfaces in nested pairs.
    expect(topPair).toBeDefined();
    const childPair = lineage!.entries.find((e) => e.position === 0 && e.caller.fieldName === "WS-FIELD");
    expect(childPair).toBeDefined();
  });

  it("CICS DFHCOMMAREA: caller's single USING arg pairs with DFHCOMMAREA when callee has multiple LINKAGE records (#26 phase 4)", () => {
    // Realistic CICS program shape: LINKAGE declares both the implicit
    // DFHCOMMAREA and additional work records. Pre-fix the analyzer
    // compared raw linkage count (>1) against caller's single USING arg
    // and fired a false `arity-mismatch`. Phase 4 narrows the effective
    // linkage to just DFHCOMMAREA in this case (the CICS convention).
    const cicsCallee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CICSCALEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  DFHCOMMAREA.
           05  COMM-FIELD   PIC X(20).
       01  LK-EXTRA.
           05  EXTRA-FIELD  PIC X(10).
       PROCEDURE DIVISION.
           GOBACK.
`;
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-COMM-RECORD.
           05  WS-COMM-FIELD   PIC X(20).
       PROCEDURE DIVISION.
       A100.
           CALL "CICSCALEE" USING WS-COMM-RECORD.
           STOP RUN.
`;
    const lineage = buildCallBoundLineage([
      model(cicsCallee, "CICSCALEE.cbl"),
      model(caller, "CALLER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    // No arity-mismatch; pair succeeds with DFHCOMMAREA.
    expect(lineage!.diagnostics.some((d) => d.kind === "arity-mismatch")).toBe(false);
    expect(lineage!.entries.length).toBeGreaterThan(0);
    // Pair callee side is DFHCOMMAREA, not LK-EXTRA.
    const topEntry = lineage!.entries.find((e) => e.position === 0);
    expect(topEntry?.callee.fieldName).toBe("DFHCOMMAREA");
  });

  it("CICS DFHCOMMAREA: simple single-LINKAGE case still works (no regression #26 phase 4)", () => {
    // The single-DFHCOMMAREA case worked pre-fix (arity matches at 1=1).
    // Verify the Phase 4 fallthrough doesn't break it.
    const cicsCallee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CICSCALEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  DFHCOMMAREA.
           05  COMM-FIELD   PIC X(20).
       PROCEDURE DIVISION.
           GOBACK.
`;
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-COMM-RECORD.
           05  WS-COMM-FIELD   PIC X(20).
       PROCEDURE DIVISION.
       A100.
           CALL "CICSCALEE" USING WS-COMM-RECORD.
           STOP RUN.
`;
    const lineage = buildCallBoundLineage([
      model(cicsCallee, "CICSCALEE.cbl"),
      model(caller, "CALLER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.diagnostics.filter((d) => d.kind === "arity-mismatch")).toHaveLength(0);
    expect(lineage!.entries.length).toBeGreaterThan(0);
  });

  it("CICS DFHCOMMAREA: 2-arg caller does NOT trigger DFHCOMMAREA narrowing (#26 phase 4)", () => {
    // Phase 4 only applies when caller passes exactly 1 arg. If the
    // caller passes multiple args, the standard pair-by-position
    // handling runs (and may surface a real arity-mismatch).
    const cicsCallee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CICSCALEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  DFHCOMMAREA.
           05  COMM-FIELD   PIC X(20).
       01  LK-EXTRA.
           05  EXTRA-FIELD  PIC X(10).
       PROCEDURE DIVISION.
           GOBACK.
`;
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A    PIC X(20).
       01  WS-B    PIC X(10).
       01  WS-C    PIC X(5).
       PROCEDURE DIVISION.
       A100.
           CALL "CICSCALEE" USING WS-A WS-B WS-C.
           STOP RUN.
`;
    const lineage = buildCallBoundLineage([
      model(cicsCallee, "CICSCALEE.cbl"),
      model(caller, "CALLER.cbl"),
    ]);

    // 3 args vs 2 LINKAGE records → real arity-mismatch, narrowing
    // doesn't apply.
    expect(lineage!.diagnostics.some((d) => d.kind === "arity-mismatch")).toBe(true);
  });

  it("project-local extraSystemCallees option promotes additional names to system-call (#26 phase 2)", () => {
    // Phase 2: site-specific runtime libraries shouldn't go in the
    // open-source whitelist, but should be classifiable as system-call
    // by callers passing a project-local extension list (loaded from a
    // gitignored `.agent-wiki.local.yaml`). Synthetic placeholder name
    // `YOURRTN1` stands in for what would be a real site runtime in
    // production.
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A       PIC X(8).
       PROCEDURE DIVISION.
       A100.
           CALL "YOURRTN1" USING WS-A.
           STOP RUN.
`;
    const otherUser = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OTHER.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-X       PIC X(8).
       PROCEDURE DIVISION USING LK-X.
       A100.
           GOBACK.
`;
    const models = [
      model(caller, "CALLER.cbl"),
      model(otherUser, "OTHER.cbl"),
    ];

    // Without the option: YOURRTN1 is treated as missing user program.
    const lineageDefault = buildCallBoundLineage(models);
    expect(lineageDefault!.diagnostics.some(
      (d) => d.kind === "unresolved-callee" && d.target === "YOURRTN1",
    )).toBe(true);

    // With the option: YOURRTN1 is reclassified as system-call.
    const lineageWithExtra = buildCallBoundLineage(models, {
      extraSystemCallees: ["YOURRTN1"],
    });
    expect(lineageWithExtra!.diagnostics.some(
      (d) => d.kind === "system-call" && d.target === "YOURRTN1",
    )).toBe(true);
    expect(lineageWithExtra!.diagnostics.some(
      (d) => d.kind === "unresolved-callee" && d.target === "YOURRTN1",
    )).toBe(false);
  });

  it("extraSystemCallees is case-insensitive — array input (#26 phase 2)", () => {
    // Caller-passed names are uppercased before matching, so the
    // local-config can use any case convention without affecting
    // detection.
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A       PIC X(8).
       PROCEDURE DIVISION.
       A100.
           CALL "MIXEDCASE" USING WS-A.
           STOP RUN.
`;
    const otherUser = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OTHER.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-X       PIC X(8).
       PROCEDURE DIVISION USING LK-X.
       A100.
           GOBACK.
`;
    const lineage = buildCallBoundLineage(
      [model(caller, "CALLER.cbl"), model(otherUser, "OTHER.cbl")],
      { extraSystemCallees: ["mixedcase"] },
    );
    const sysCall = lineage!.diagnostics.find(
      (d) => d.kind === "system-call" && d.target === "MIXEDCASE",
    );
    expect(sysCall).toBeDefined();
    // Phase 2 rationale split: project-local extension has its own text,
    // distinct from the IBM-whitelist branch.
    expect(sysCall!.rationale).toContain("project-local system-call extension");
    expect(sysCall!.rationale).not.toContain("IBM");
  });

  it("extraSystemCallees accepts spread-from-Set input via uppercase normalization (#26 phase 2)", () => {
    // Caller has a Set in hand (e.g., already-deduped config). Spreading
    // it into an array still yields correct case-insensitive matching.
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A       PIC X(8).
       PROCEDURE DIVISION.
       A100.
           CALL "SETCASE" USING WS-A.
           STOP RUN.
`;
    const otherUser = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OTHER.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-X       PIC X(8).
       PROCEDURE DIVISION USING LK-X.
       A100.
           GOBACK.
`;
    const lineage = buildCallBoundLineage(
      [model(caller, "CALLER.cbl"), model(otherUser, "OTHER.cbl")],
      { extraSystemCallees: [...new Set(["setcase"])] },  // spread from Set
    );
    expect(lineage!.diagnostics.some(
      (d) => d.kind === "system-call" && d.target === "SETCASE",
    )).toBe(true);
  });

  it("system-call rationale on IBM-whitelist match retains IBM-specific attribution (#26 phase 1)", () => {
    // IBM-whitelist branch and project-local extension branch produce
    // different rationale text so users can tell which classification
    // path matched.
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-A       PIC X(8).
       PROCEDURE DIVISION.
       A100.
           CALL "MQCONN" USING WS-A.
           STOP RUN.
`;
    const otherUser = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OTHER.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-X       PIC X(8).
       PROCEDURE DIVISION USING LK-X.
       A100.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(otherUser, "OTHER.cbl"),
    ]);
    const sysCall = lineage!.diagnostics.find(
      (d) => d.kind === "system-call" && d.target === "MQCONN",
    );
    expect(sysCall).toBeDefined();
    expect(sysCall!.rationale).toContain("IBM");
    expect(sysCall!.rationale).not.toContain("project-local");
  });

  it("Phase 3 copybook resolver is deterministic across input orders for duplicate canonical names", () => {
    // Two copybook files share the basename TESTREC.cpy from different
    // directories. The map sort by sourceFile should produce the same
    // resolution regardless of the input array order.
    const cpyA = `
       01  TEST-RECORD.
           05  FIELD-V1   PIC X(10).
`;
    const cpyB = `
       01  TEST-RECORD.
           05  FIELD-V2   PIC X(99).
`;
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY TESTREC.
       PROCEDURE DIVISION.
       A100.
           CALL "CALLEE" USING TEST-RECORD.
           STOP RUN.
`;
    const callee = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-RECORD.
           05  LK-FIELD    PIC X(10).
       PROCEDURE DIVISION USING LK-RECORD.
       A100.
           GOBACK.
`;
    const a = model(cpyA, "dir-a/TESTREC.cpy");
    const b = model(cpyB, "dir-b/TESTREC.cpy");
    const c = model(caller, "CALLER.cbl");
    const d = model(callee, "CALLEE.cbl");

    const findChildName = (lineage: ReturnType<typeof buildCallBoundLineage>): string | undefined =>
      lineage?.entries.find((e) => e.position === 0 && e.caller.fieldName !== "TEST-RECORD")?.caller.fieldName;

    const lineage1 = buildCallBoundLineage([a, b, c, d]);
    const lineage2 = buildCallBoundLineage([b, a, c, d]);
    // Both orders should resolve to the same copybook variant.
    // dir-a sorts before dir-b → FIELD-V1 wins deterministically.
    expect(findChildName(lineage1)).toBe("FIELD-V1");
    expect(findChildName(lineage2)).toBe("FIELD-V1");
  });

  it("dynamic CALL <var> resolving to an IBM API name does NOT match the whitelist (#26 phase 1)", () => {
    // The whitelist is gated behind targetKind === "literal" — a runtime-
    // resolved CALL <variable> stays a dynamic-call diagnostic regardless
    // of whether the value at the call site happens to match an IBM API
    // name. Static lineage can't see the variable's runtime value.
    const caller = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-PROG-NAME       PIC X(8).
       01  WS-A               PIC X(8).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           MOVE "MQCONN" TO WS-PROG-NAME.
           CALL WS-PROG-NAME USING WS-A.
           STOP RUN.
`;
    const otherUser = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OTHER.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LK-X       PIC X(8).
       PROCEDURE DIVISION USING LK-X.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const lineage = buildCallBoundLineage([
      model(caller, "CALLER.cbl"),
      model(otherUser, "OTHER.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.diagnostics.some((d) => d.kind === "system-call")).toBe(false);
    expect(lineage!.diagnostics.some((d) => d.kind === "dynamic-call")).toBe(true);
  });
});
