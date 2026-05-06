import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import { attachCallBoundLineage, buildFieldLineage, generateFieldLineagePage } from "../field-lineage.js";
import { buildCallBoundLineage } from "../call-boundary-lineage.js";

function model(source: string, filename: string) {
  return extractModel(parse(source, filename));
}

const sharedCopybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-ADDRESS.
               10  ZIP-CODE      PIC 9(5).
`;

const customerA = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-NAME     PIC X(30).
`;

const customerB = `
       01  CLIENT-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-NAME     PIC X(30).
`;

const legacyCustomer = `
       01  LEGACY-CUSTOMER.
           05  CUSTOMER-ID       PIC 9(8).
`;

const nestedCustomer = `
       01  ORDER-REC.
           05  HEADER.
               10  CUSTOMER-ID   PIC X(10).
               10  CUSTOMER-NAME PIC X(30).
`;

function program(programId: string, copybook: string): string {
  return `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${programId}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY ${copybook}.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
}

describe("COBOL field lineage", () => {
  it("builds deterministic shared lineage for the same parsed copybook across programs", () => {
    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl"),
      model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const zipCode = lineage!.deterministic.find((entry) => entry.fieldName === "ZIP-CODE");
    expect(zipCode).toBeDefined();
    expect(zipCode!.copybooks.map((copybook) => copybook.id)).toEqual(["copybook:CUSTOMER-REC"]);
    expect(zipCode!.programs.map((program) => program.id)).toEqual(["program:ORDERA", "program:ORDERB"]);
    expect(zipCode!.qualifiedNames).toContain("CUSTOMER-REC.CUSTOMER-ADDRESS.ZIP-CODE");
    expect(zipCode!.parentQualifiedNames).toContain("CUSTOMER-REC.CUSTOMER-ADDRESS");
    expect(zipCode!.linkage).toBe("deterministic");
  });

  it("infers same-name same-type fields across different copybooks when structural context aligns", () => {
    const lineage = buildFieldLineage([
      model(customerA, "CUSTOMER-A.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(program("BILLINGA", "CUSTOMER-A"), "BILLINGA.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.deterministic.fields).toBe(0);
    expect(lineage!.summary.inferred.highConfidence).toBeGreaterThan(0);
    const customerId = lineage!.inferredHighConfidence.find((entry) => entry.fieldName === "CUSTOMER-ID");
    expect(customerId).toBeDefined();
    expect(customerId!.left.copybook.id).toBe("copybook:CUSTOMER-A");
    expect(customerId!.right.copybook.id).toBe("copybook:CUSTOMER-B");
    expect(customerId!.evidence.parentContextMatch).toBe("top-level");
    expect(customerId!.evidence.siblingOverlap).toContain("CUSTOMER-NAME");
    expect(customerId!.evidence.usageEvidence).toBe("both-missing");
    expect(customerId!.rationale).not.toContain("matching USAGE");
  });

  it("does not infer same-name fields when structural context differs", () => {
    const lineage = buildFieldLineage([
      model(customerA, "CUSTOMER-A.cpy"),
      model(nestedCustomer, "NESTED-CUSTOMER.cpy"),
      model(program("BILLINGA", "CUSTOMER-A"), "BILLINGA.cbl"),
      model(program("ORDERPROC", "NESTED-CUSTOMER"), "ORDERPROC.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("does not infer same-name fields when PIC conflicts", () => {
    const customerNumericId = `
       01  NUMERIC-REC.
           05  CUSTOMER-ID       PIC 9(8).
           05  CUSTOMER-NAME     PIC X(30).
`;

    const lineage = buildFieldLineage([
      model(customerA, "CUSTOMER-A.cpy"),
      model(customerNumericId, "CUSTOMER-NUMERIC.cpy"),
      model(program("BILLINGA", "CUSTOMER-A"), "BILLINGA.cbl"),
      model(program("BILLINGN", "CUSTOMER-NUMERIC"), "BILLINGN.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const conflictingId = [
      ...lineage!.inferredHighConfidence,
      ...lineage!.inferredAmbiguous,
    ].find((entry) => entry.fieldName === "CUSTOMER-ID");
    expect(conflictingId).toBeUndefined();
    const matchingName = lineage!.inferredHighConfidence.find((entry) => entry.fieldName === "CUSTOMER-NAME");
    expect(matchingName).toBeDefined();
  });

  it("does not infer same-name fields when USAGE conflicts", () => {
    const customerCompId = `
       01  COMP-REC.
           05  CUSTOMER-ID       PIC 9(8) USAGE COMP-3.
           05  CUSTOMER-NAME     PIC X(30).
`;
    const customerDispId = `
       01  DISP-REC.
           05  CUSTOMER-ID       PIC 9(8) USAGE DISPLAY.
           05  CUSTOMER-NAME     PIC X(30).
`;

    const lineage = buildFieldLineage([
      model(customerCompId, "CUSTOMER-COMP.cpy"),
      model(customerDispId, "CUSTOMER-DISP.cpy"),
      model(program("BILLINGC", "CUSTOMER-COMP"), "BILLINGC.cbl"),
      model(program("BILLINGD", "CUSTOMER-DISP"), "BILLINGD.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const conflictingId = [
      ...lineage!.inferredHighConfidence,
      ...lineage!.inferredAmbiguous,
    ].find((entry) => entry.fieldName === "CUSTOMER-ID");
    expect(conflictingId).toBeUndefined();
    const matchingName = lineage!.inferredHighConfidence.find((entry) => entry.fieldName === "CUSTOMER-NAME");
    expect(matchingName).toBeDefined();
  });

  it("marks competing cross-copybook matches as ambiguous", () => {
    const customerC = `
       01  PARTY-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-NAME     PIC X(30).
`;

    const lineage = buildFieldLineage([
      model(customerA, "CUSTOMER-A.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(customerC, "CUSTOMER-C.cpy"),
      model(program("BILLINGA", "CUSTOMER-A"), "BILLINGA.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
      model(program("BILLINGC", "CUSTOMER-C"), "BILLINGC.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.inferred.highConfidence).toBe(0);
    expect(lineage!.summary.inferred.ambiguous).toBeGreaterThan(0);
    const customerId = lineage!.inferredAmbiguous.find((entry) => entry.fieldName === "CUSTOMER-ID");
    expect(customerId).toBeDefined();
    expect(customerId!.evidence.competingMatches).toBeGreaterThan(0);
  });

  it("does not treat COPY REPLACING consumers as deterministic shared lineage", () => {
    const orderA = model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl");
    const orderB = model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl");
    orderB.copies[0]!.replacing = ["CUSTOMER-ID", "CLIENT-ID"];

    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      orderA,
      orderB,
    ]);

    expect(lineage).toBeNull();
  });

  it("summary counts only programs that actually participate in deterministic lineage", () => {
    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl"),
      model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.deterministic.programs).toBe(2);
    expect(lineage!.copybookUsage.map((entry) => entry.copybookId)).toEqual([
      "copybook:CUSTOMER-REC",
    ]);
  });

  it("copybook usage excludes consumers that do not participate in lineage evidence", () => {
    const orderA = model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl");
    const orderB = model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl");
    const orderC = model(program("ORDERC", "CUSTOMER-REC"), "ORDERC.cbl");
    orderC.copies[0]!.replacing = ["CUSTOMER-ID", "CLIENT-ID"];

    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      orderA,
      orderB,
      orderC,
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.deterministic.programs).toBe(2);
    expect(lineage!.copybookUsage).toHaveLength(1);
    expect(lineage!.copybookUsage[0]!.programs.map((program) => program.id)).toEqual([
      "program:ORDERA",
      "program:ORDERB",
    ]);
  });

  it("copybook usage filters programs per copybook, not by global participation", () => {
    const altCopybook = `
       01  ALT-REC.
           05  ALT-ID            PIC X(6).
`;
    const orderA = model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl");
    const orderB = model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl");
    const orderCSource = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       COPY ALT-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
    const orderC = model(orderCSource, "ORDERC.cbl");
    orderC.copies[0]!.replacing = ["CUSTOMER-ID", "CLIENT-ID"];
    const orderD = model(program("ORDERD", "ALT-REC"), "ORDERD.cbl");

    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(altCopybook, "ALT-REC.cpy"),
      orderA,
      orderB,
      orderC,
      orderD,
    ]);

    expect(lineage).not.toBeNull();
    expect(lineage!.summary.deterministic.programs).toBe(4);
    const customerUsage = lineage!.copybookUsage.find((entry) => entry.copybookId === "copybook:CUSTOMER-REC");
    const altUsage = lineage!.copybookUsage.find((entry) => entry.copybookId === "copybook:ALT-REC");
    expect(customerUsage?.programs.map((program) => program.id)).toEqual([
      "program:ORDERA",
      "program:ORDERB",
    ]);
    expect(altUsage?.programs.map((program) => program.id)).toEqual([
      "program:ORDERC",
      "program:ORDERD",
    ]);
  });

  it("does not conflate parsed copybooks that share the same basename", () => {
    const billingCommon = `
       01  BILLING-COMMON.
           05  SHARED-ID         PIC X(10).
`;
    const claimsCommon = `
       01  CLAIMS-COMMON.
           05  CLAIM-ID          PIC 9(8).
`;

    const lineage = buildFieldLineage([
      model(billingCommon, "billing/COMMON.cpy"),
      model(claimsCommon, "claims/COMMON.cpy"),
      model(program("BILLINGA", "COMMON"), "BILLINGA.cbl"),
      model(program("BILLINGB", "COMMON"), "BILLINGB.cbl"),
    ]);

    expect(lineage).toBeNull();
  });

  it("renders call-bound section with per-group summary highlighting high-confidence count", () => {
    const callerSrc = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-REC.
           05  WS-FIELD-A      PIC X(5).
           05  WS-OTHER        PIC X(5).
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
           05  LK-FIELD-A      PIC X(5).
           05  RENAMED-CHILD   PIC X(5).
       PROCEDURE DIVISION USING LK-REC.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
    const callLineage = buildCallBoundLineage([
      model(callerSrc, "CALLER.cbl"),
      model(calleeSrc, "CALLEE.cbl"),
    ]);
    const lineage = attachCallBoundLineage(null, callLineage);
    expect(lineage).not.toBeNull();

    const page = generateFieldLineagePage(lineage!);
    // No copybook content, so those sections are omitted entirely.
    expect(page.content).not.toContain("Copybook Usage");
    expect(page.content).not.toContain("Shared Copybook-Backed Fields");
    expect(page.content).not.toContain("Inferred Cross-Copybook Candidates");
    // One name diverges (WS-OTHER ↔ RENAMED-CHILD), so the per-group summary
    // should report the mixed deterministic/high-confidence breakdown.
    expect(page.content).toMatch(/\d+ pair\(s\): \d+ deterministic, 1 high-confidence/);
    expect(page.content).toContain("review below");
  });

  it("renders the Excluded-by-diagnostic section only when diagnostics are present", () => {
    // Two-program corpus where the only CALL site has a shape-mismatch:
    // the entry list is empty, but a diagnostic should surface in the page.
    const callerSrc = `
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
    const calleeSrc = `
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
    const callLineage = buildCallBoundLineage([
      model(callerSrc, "CALLER.cbl"),
      model(calleeSrc, "CALLEE.cbl"),
    ]);
    const lineage = attachCallBoundLineage(null, callLineage);
    expect(lineage).not.toBeNull();
    const page = generateFieldLineagePage(lineage!);
    expect(page.content).toContain("## Call Boundary Field Lineage");
    expect(page.content).toContain("### Excluded by diagnostic");
    expect(page.content).toContain("shape-mismatch");
  });

  it("omits the Excluded section when there are no diagnostics", () => {
    // Same shape on both sides — the call resolves cleanly and no diagnostic fires.
    const callerSrc = `
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
    const calleeSrc = `
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
    const callLineage = buildCallBoundLineage([
      model(callerSrc, "CALLER.cbl"),
      model(calleeSrc, "CALLEE.cbl"),
    ]);
    const lineage = attachCallBoundLineage(null, callLineage);
    expect(lineage).not.toBeNull();
    const page = generateFieldLineagePage(lineage!);
    expect(page.content).toContain("## Call Boundary Field Lineage");
    expect(page.content).not.toContain("### Excluded by diagnostic");
  });

  it("generates a lineage wiki summary page", () => {
    const lineage = buildFieldLineage([
      model(sharedCopybook, "CUSTOMER-REC.cpy"),
      model(customerB, "CUSTOMER-B.cpy"),
      model(legacyCustomer, "LEGACY-CUSTOMER.cpy"),
      model(program("ORDERA", "CUSTOMER-REC"), "ORDERA.cbl"),
      model(program("ORDERB", "CUSTOMER-REC"), "ORDERB.cbl"),
      model(program("BILLINGB", "CUSTOMER-B"), "BILLINGB.cbl"),
      model(program("LEGACYB", "LEGACY-CUSTOMER"), "LEGACYB.cbl"),
    ]);

    expect(lineage).not.toBeNull();
    const page = generateFieldLineagePage(lineage!);
    expect(page.path).toBe("cobol/field-lineage.md");
    expect(page.content).toContain("COBOL Field Lineage");
    expect(page.content).toContain("Shared Copybook-Backed Fields");
    expect(page.content).toContain("Inferred Cross-Copybook Candidates");
    expect(page.content).toContain("High Confidence");
    expect(page.content).toContain("Ambiguous");
    expect(page.content).toContain("CUSTOMER-REC");
  });
});
