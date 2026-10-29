// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
});
