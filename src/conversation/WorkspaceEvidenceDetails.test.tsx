// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { WorkspaceEvidenceDetails } from "./WorkspaceEvidenceDetails";
import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "../coordination/coordinateGoal";

describe("WorkspaceEvidenceDetails", () => {
  afterEach(cleanup);

  it("renders nothing when neither evidence nor executionText is provided", () => {
    const { container } = render(<WorkspaceEvidenceDetails />);
    expect(container.firstChild).toBeNull();
  });

  it("renders executor report labeled accurately when only executionText is provided", () => {
    render(<WorkspaceEvidenceDetails executionText="I changed some files." executionHarness="Codex" />);
    expect(screen.getByText("Executor report — Codex")).toBeTruthy();
    expect(screen.getByText("I changed some files.")).toBeTruthy();
  });

  it("discloses optional stdin bytes without claiming byte-identical model input; absent stays legacy", () => {
    const evidence: ExecutionWorkspaceEvidence = { status: "available", complete: true, changed: true, beforeDiff: "", afterDiff: "+actual text" };
    const coverage = { totalEvidenceBytes: 10000, includedEvidenceBytes: 10000, cropped: false, promptBytes: 13000, promptBudgetBytes: 32768 };
    const { rerender } = render(<WorkspaceEvidenceDetails evidence={evidence} auditInputEvidenceCoverage={coverage} auditInputEvidenceText="unchanged subset" />);
    expect(screen.queryByText(/Selected prompt transport/)).toBeNull();
    expect(screen.queryByText(/Only part of the workspace material was supplied/)).toBeNull();
    rerender(<WorkspaceEvidenceDetails evidence={evidence} auditInputEvidenceCoverage={{ ...coverage, promptDelivery: "stdin" }} auditInputEvidenceText="unchanged subset" />);
    expect(screen.getByText(/13000 UTF-8 bytes within its 32768-byte budget/)).toBeTruthy();
    expect(screen.getByText(/Selected prompt transport: stdin/)).toBeTruthy();
    expect(screen.getByText(/Pi trims edge whitespace/)).toBeTruthy();
    expect(screen.queryByText(/Only part of the workspace material was supplied/)).toBeNull();
    rerender(<WorkspaceEvidenceDetails evidence={{ ...evidence, untrackedFiles: [{ path: "binary.bin", binary: true, size: 80 }] }} auditInputEvidenceCoverage={{ ...coverage, promptDelivery: "stdin" }} />);
    expect(screen.getByText(/Only part of the workspace material was supplied; omitted content was not delivered in this prompt/)).toBeTruthy();
  });

  it("keeps complete multi-file capture readable when the delivered subset is cropped", () => {
    const files = [
      { path: "first.txt", content: "FIRST_BEGIN\nfirst file body\nFIRST_END" },
      { path: "second.txt", content: "SECOND_BEGIN\nsecond file body\nSECOND_END" },
    ];
    const evidence: ExecutionWorkspaceEvidence = {
      status: "available", complete: true, changed: true, beforeDiff: "", afterDiff: "",
      untrackedFiles: files,
    };
    const fullMaterial = files.map(file => `${file.path}\n${file.content}`).join("\n");
    const coverage: AuditInputEvidenceCoverage = {
      totalEvidenceBytes: fullMaterial.length, includedEvidenceBytes: fullMaterial.length,
      cropped: false, promptBytes: fullMaterial.length + 200, promptBudgetBytes: 32768, promptDelivery: "stdin",
    };
    const { rerender } = render(<WorkspaceEvidenceDetails evidence={evidence} auditInputEvidenceCoverage={coverage} auditInputEvidenceText={fullMaterial} />);
    const auditDetails = () => within(screen.getByText("What the independent audit received").closest("details")!);
    expect(auditDetails().getByText(/FIRST_BEGIN/, { selector: "pre" }).textContent).toBe(fullMaterial);
    expect(auditDetails().getByText(/No captured-material section was cropped for transport/)).toBeTruthy();
    expect(auditDetails().queryByText(/Only part of the workspace material was supplied/)).toBeNull();

    const retainedPrefix = "first.txt\nFIRST_BEGIN\nfirst file body\n";
    const croppedMaterial = `${retainedPrefix}[AFTER untracked files cropped for transport; full capture retained]`;
    rerender(<WorkspaceEvidenceDetails evidence={evidence} auditInputEvidenceCoverage={{
      ...coverage, includedEvidenceBytes: retainedPrefix.length, cropped: true, croppedSections: ["AFTER untracked files"],
      promptBytes: croppedMaterial.length + 200,
    }} auditInputEvidenceText={croppedMaterial} />);

    for (const file of files) {
      const capturedFile = screen.getByText(file.path).closest("li")!;
      expect(within(capturedFile).getByText(/_BEGIN/, { selector: "pre" }).textContent).toBe(file.content);
    }
    const delivered = auditDetails().getByText(/FIRST_BEGIN/, { selector: "pre" });
    expect(delivered.textContent).toBe(croppedMaterial);
    expect(delivered.textContent).not.toContain("FIRST_END");
    expect(delivered.textContent).not.toMatch(/second\.txt|SECOND_BEGIN|SECOND_END/);
    expect(auditDetails().getByText(/Only part of the workspace material was supplied/)).toBeTruthy();
    expect(auditDetails().getByText(/Cropped: AFTER untracked files/)).toBeTruthy();
    expect(auditDetails().queryByText(/No captured-material section was cropped for transport/)).toBeNull();
  });

  it.each<{ name: string; evidence: ExecutionWorkspaceEvidence; disclosure: RegExp }>([
    {
      name: "unavailable capture",
      evidence: { status: "unavailable", complete: false, changed: null, beforeDiff: null, afterDiff: null, reason: "Git capture was unavailable." },
      disclosure: /Git capture was unavailable/,
    },
    {
      name: "truncated file capture",
      evidence: {
        status: "incomplete", complete: false, changed: true, beforeDiff: "", afterDiff: "",
        untrackedFiles: [{ path: "large.txt", size: 16000, content: "RETAINED_FILE_PREFIX", truncated: true }],
      },
      disclosure: /16000 bytes, capture truncated/,
    },
    {
      name: "omitted capture paths",
      evidence: {
        status: "incomplete", complete: false, changed: true, beforeDiff: "", afterDiff: "",
        untrackedFiles: [{ path: "retained.txt", size: 4, content: "kept" }], untrackedFilesOmitted: 3,
      },
      disclosure: /3 additional paths were omitted by the capture file limit/,
    },
  ])("discloses $name even when transport is uncropped", ({ evidence, disclosure }) => {
    const material = JSON.stringify(evidence);
    render(<WorkspaceEvidenceDetails evidence={evidence} auditInputEvidenceCoverage={{
      totalEvidenceBytes: material.length, includedEvidenceBytes: material.length, cropped: false,
      promptBytes: material.length + 200, promptDelivery: "stdin",
    }} auditInputEvidenceText={material} />);
    expect(screen.getByText(disclosure, { selector: "p, li" })).toBeTruthy();
    const delivered = within(screen.getByText("What the independent audit received").closest("details")!);
    expect(delivered.getByText(/No captured-material section was cropped for transport/)).toBeTruthy();
    expect(delivered.getByText(/Only part of the workspace material was supplied; omitted content was not delivered in this prompt/)).toBeTruthy();
  });

  it("renders captured workspace diff, untracked files, and crop coverage when evidence is present", () => {
    const evidence: ExecutionWorkspaceEvidence = {
      status: "available",
      complete: true,
      changed: true,
      beforeDiff: "--- a/old.txt\n+++ b/old.txt\n@@ -1 +1 @@\n-old\n+UNIQUE_BEFORE_UI_MARKER",
      afterDiff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-hello\n+UNIQUE_AFTER_UI_MARKER",
      beforeUntrackedFiles: [{ path: "old-untracked.txt", size: 28, content: "UNIQUE_BEFORE_FILE_UI_MARKER", binary: false }],
      untrackedFiles: [
        { path: "new-file.txt", size: 42, content: "UNIQUE_NEW_FILE_CONTENT_UI_MARKER", binary: false, truncated: false },
        { path: "bin.dat", size: 100, binary: true },
        { path: "sym.lnk", skipped: "symlink" },
      ],
      comparisonBaseline: { headCommit: "2dbea545040c2bb3bdc66b95602975adc951d5a0", capturedAt: "2026-10-28T00:00:00Z" },
      reason: "Changes observed",
      label: "Workspace observation before/after this round",
    };

    const coverage: AuditInputEvidenceCoverage = {
      totalEvidenceBytes: 15000,
      includedEvidenceBytes: 8000,
      cropped: true,
      promptBytes: 12000,
    };

    render(
      <WorkspaceEvidenceDetails
        evidence={evidence}
        executionText="Executor claims it did everything."
        executionHarness="Codex"
        auditInputEvidenceCoverage={coverage}
        auditInputEvidenceText="EXACT_DELIVERED_AUDIT_SUBSET\nUNIQUE_NEW_FILE_CONTENT_UI_MARKER"
      />
    );

    expect(screen.getByText("Workspace changes — changes observed")).toBeTruthy();
    expect(screen.getByText("Workspace observation before/after this round")).toBeTruthy();
    expect(screen.getByText("Baseline: 2dbea545")).toBeTruthy();
    expect(screen.getByText(/--- a\/file\.txt/)).toBeTruthy();
    expect(screen.getByText("Pre-execution baseline diff")).toBeTruthy();
    expect(screen.getByText("new-file.txt")).toBeTruthy();
    expect(screen.getByText("UNIQUE_NEW_FILE_CONTENT_UI_MARKER", { selector: ".workspace-untracked-content" })).toBeTruthy();
    expect(screen.getByText("UNIQUE_BEFORE_FILE_UI_MARKER")).toBeTruthy();
    expect(screen.getByText(/UNIQUE_BEFORE_UI_MARKER/)).toBeTruthy();
    expect(screen.getByText(/UNIQUE_AFTER_UI_MARKER/)).toBeTruthy();
    expect(screen.getByText("What the independent audit received")).toBeTruthy();
    expect(screen.getByText(/EXACT_DELIVERED_AUDIT_SUBSET/)).toBeTruthy();
    expect(screen.getByText("bin.dat")).toBeTruthy();
    expect(screen.getByText(/Audit delivery contains 8000 of 15000 original captured-material bytes/)).toBeTruthy();
    expect(screen.getByText(/complete assembled prompt was 12000 UTF-8 bytes/)).toBeTruthy();
    expect(screen.getByText("Executor report — Codex")).toBeTruthy();
    expect(screen.getByText("Executor claims it did everything.")).toBeTruthy();
  });

  it("keeps old records without coverage or transport metadata readable without inventing delivery claims", () => {
    const evidence: ExecutionWorkspaceEvidence = {
      status: "available", complete: true, changed: true, beforeDiff: "", afterDiff: "+LEGACY_DIFF_END",
      untrackedFiles: [{ path: "legacy.txt", content: "LEGACY_FILE_END" }],
    };
    const retainedSubset = "LEGACY_AUDIT_BEGIN\nLEGACY_AUDIT_END";
    render(<WorkspaceEvidenceDetails evidence={evidence} auditInputEvidenceText={retainedSubset} />);
    expect(screen.getByText("+LEGACY_DIFF_END")).toBeTruthy();
    expect(screen.getByText("LEGACY_FILE_END")).toBeTruthy();
    const delivered = within(screen.getByText("What the independent audit received").closest("details")!);
    expect(delivered.getByText(/LEGACY_AUDIT_BEGIN/, { selector: "pre" }).textContent).toBe(retainedSubset);
    expect(delivered.queryByText(/Selected prompt transport|Audit delivery contains|UTF-8 bytes|No captured-material section was cropped/)).toBeNull();
    expect(delivered.queryByText(/Pi trims edge whitespace|exact delivered evidence subset was not retained/)).toBeNull();
  });
});
