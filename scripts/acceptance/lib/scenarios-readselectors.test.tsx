// @vitest-environment jsdom
// R2 focused pin (independent execution audit r1): the Harness access panel now
// renders the workspace-changes decision as a SECOND list, so two discovered
// harnesses produce four checkboxes (two read members plus two default-OFF write
// members) and one harness produces two rows. The shared Track A driver may only
// count/select READ members and must prove write consent stays OFF.
//
// These cases render the REAL current component and feed its DOM through the
// driver's own exported expressions/predicates, so a future panel change that
// breaks read/write separation fails here before it can invalidate a native run.
// The negative control checks a write box on purpose: that is what the old
// all-checkbox predicate effectively required, and the driver must refuse it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "../../../src/coordination/catalogFromProviders";
import { AuthorizationPanel } from "../../../src/conversation/AuthorizationPanel";

interface DriverModule {
  AUTHORIZATION: { panel: string; readControl: string; writeControl: string; readRow: string; writeSection: string; noWriteSentence: string };
  SCENARIOS: Record<string, { budget: number; widths: number[]; behavior: { probes: Record<string, string>; turns: Record<string, string[]> } }>;
  artifactAssertions: (artifacts: unknown) => Record<string, boolean>;
  authorizationFactsExpression: () => string;
  readAuthorizationAssertions: (facts: unknown, options: { names: string[]; budget: number }) => Record<string, boolean>;
  readSelectLabel: (name: string) => string;
  validateScenario: (config: unknown) => unknown;
  writeConsentOff: (facts: unknown) => boolean;
}

// The driver is a plain Node ESM module (it resolves ROOT from its own
// import.meta.url and requires the Electron bridge spec), so it is loaded
// through Node's native loader instead of the vitest transform pipeline.
// `createRequire` with an absolute path keeps the resolution native.
const libDir = (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), "scripts/acceptance/lib");
const requireFromLib = createRequire(path.join(libDir, "scenarios-readselectors.test.tsx"));
const driver = requireFromLib("./scenarios.mjs") as DriverModule;
const { AUTHORIZATION, SCENARIOS, artifactAssertions, authorizationFactsExpression, readAuthorizationAssertions, readSelectLabel, validateScenario, writeConsentOff } = driver;

interface AuthorizationFacts {
  readSelects: { label: string; instance: string | null; checked: boolean }[];
  writeSelects: { label: string; checked: boolean }[];
  readRows: { instance: string; state: string }[];
  readTurnsValue: string | null;
  writeSectionPresent: boolean;
  noWriteSentenceShown: boolean;
}

const codex: ProviderSnapshot = {
  instanceId: "codex", displayName: "Codex", driver: "codex", enabled: true, installed: true,
  availability: "available", status: "ready",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT" },
  models: [{ slug: "default", name: "Codex built-in default", isDefault: true, isLegacy: false }],
};
const claude: ProviderSnapshot = {
  instanceId: "claude", displayName: "Claude", driver: "claude", enabled: true, installed: true,
  availability: "available", status: "ready",
  auth: { status: "authenticated", type: "subscription", label: "subscription" },
  models: [{ slug: "opus", name: "opus", isDefault: true, isLegacy: false }],
};

const scenarioSourcePath = path.join(libDir, "scenarios.mjs");

// Mirrors the real draft panel state: the app owns the read/write selections,
// so a checked box really stays checked (a stateless stub would re-render
// controlled inputs back to unchecked).
function PanelHarness({ providers, initialSelected, scope = null }: { providers: readonly ProviderSnapshot[]; initialSelected: readonly string[]; scope?: { remaining: number; maxTurns: number } | null }) {
  const [selected, setSelected] = useState<readonly string[]>(initialSelected);
  const [writeSelected, setWriteSelected] = useState<readonly string[]>([]);
  return (
    <AuthorizationPanel
      providers={providers}
      selected={selected}
      onToggle={(instanceId, checked) => setSelected(current => checked ? [...new Set([...current, instanceId])] : current.filter(id => id !== instanceId))}
      maxTurns={4}
      onMaxTurnsChange={() => {}}
      workspaceRoot="/tmp/goalport-r2-focused-workspace"
      writeSelected={writeSelected}
      onWriteToggle={(instanceId, checked) => setWriteSelected(current => checked ? [...new Set([...current, instanceId])] : current.filter(id => id !== instanceId))}
      writeTurns={2}
      onWriteTurnsChange={() => {}}
      writeScope={null}
      scope={scope}
      changeMode={false}
      onEnterChangeMode={() => {}}
      onStopAllowing={() => {}}
      onConfirmChange={() => {}}
      onUseAgain={() => {}}
    />
  );
}

// Mirrors the real draft panel: workspace chosen, read members selected, write
// consent untouched (empty writeSelected) and no live write scope.
function mountDraftPanel(providers: readonly ProviderSnapshot[], selected: readonly string[], scope: { remaining: number; maxTurns: number } | null = null) {
  return render(<PanelHarness providers={providers} initialSelected={selected} scope={scope} />);
}

function driverFacts(): AuthorizationFacts {
  // Exactly how the driver's app.evaluate runs the expression in the renderer.
  return new Function("document", `return (${authorizationFactsExpression()});`)(document);
}

function driverSource(): string {
  return readFileSync(scenarioSourcePath, "utf8");
}

afterEach(() => { cleanup(); });

describe("R2 read-member selectors against the current two-list panel", () => {
  it("keeps a1's two read members while the separate write rows stay default-OFF", () => {
    const { container } = mountDraftPanel([codex, claude], ["codex", "claude"]);
    const facts = driverFacts();

    // Current UI reality: four checkboxes (two read members + two write members)
    // and four rows, which is exactly why the old two-checkbox/all-checked
    // assumptions could not hold.
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(4);
    expect(container.querySelectorAll(".authorization-row").length).toBe(4);
    expect(facts.readSelects.map(member => member.label)).toEqual([readSelectLabel("Codex"), readSelectLabel("Claude")]);
    expect(facts.readSelects.map(member => member.instance)).toEqual(["codex", "claude"]);
    expect(facts.readRows.map(row => row.instance)).toEqual(["codex", "claude"]);
    expect(facts.readRows.every(row => row.state.includes("selectable"))).toBe(true);
    expect(facts.writeSelects.map(member => member.label)).toEqual(["Allow changes through Codex", "Allow changes through Claude"]);
    expect(facts.writeSelects.every(member => member.checked === false)).toBe(true);
    expect(facts.readTurnsValue).toBe("4");
    expect(facts.writeSectionPresent).toBe(true);
    expect(facts.noWriteSentenceShown).toBe(true);

    expect(readAuthorizationAssertions(facts, { names: ["Codex", "Claude"], budget: 4 })).toEqual({
      readControlMembers: true,
      readMemberRows: true,
      readMembersChecked: true,
      writeConsentStaysOff: true,
      readTurnsBudget: true,
    });
    expect(Object.keys(readAuthorizationAssertions(facts, { names: ["Codex", "Claude"], budget: 4 }))).toEqual([
      "readControlMembers", "readMemberRows", "readMembersChecked", "writeConsentStaysOff", "readTurnsBudget",
    ]);
  });

  it("refuses a checked write box instead of demanding the old all-checked panel", () => {
    const { container } = mountDraftPanel([codex, claude], ["codex", "claude"]);
    // Negative control only: the driver never clicks write consent.
    const writeBox = container.querySelector('input[aria-label="Allow changes through Claude"]') as HTMLInputElement;
    fireEvent.click(writeBox);
    expect(writeBox.checked).toBe(true);

    const facts = driverFacts();
    const assertions = readAuthorizationAssertions(facts, { names: ["Codex", "Claude"], budget: 4 });
    expect(assertions.writeConsentStaysOff).toBe(false);
    expect(writeConsentOff(facts)).toBe(false);
    // Everything else about the read members stays true: the refusal is
    // specifically the write dimension, not a broken read selector.
    expect(assertions.readControlMembers).toBe(true);
    expect(assertions.readMemberRows).toBe(true);
    expect(assertions.readMembersChecked).toBe(true);
    expect(assertions.readTurnsBudget).toBe(true);
  });

  it("keeps blocked-health membership separate from the one selectable read checkbox", () => {
    const blockedCodex: ProviderSnapshot = {
      ...codex,
      environmentHealth: { since: "2026-10-10T15:00:00.000Z", detail: "helper_unknown_error" },
    };
    const { container } = mountDraftPanel([blockedCodex, claude], ["codex", "claude"], { remaining: 3, maxTurns: 4 });
    const facts = driverFacts();
    expect(facts.readRows.map(row => row.instance)).toEqual(["codex", "claude"]);
    expect(facts.readSelects.map(member => member.label)).toEqual([readSelectLabel("Claude")]);
    expect(facts.writeSelects.map(member => member.label)).toEqual(["Allow changes through Codex", "Allow changes through Claude"]);
    expect(facts.writeSelects.every(member => member.checked === false)).toBe(true);
    expect(container.querySelector('input[aria-label="Select Codex"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Allow changes through Codex"]')?.hasAttribute("disabled")).toBe(true);
    expect(facts.readRows.length === 2 && facts.readSelects.length === 1 && writeConsentOff(facts)).toBe(true);
  });

  it("counts a3's single discovered harness as one read member plus one write row", () => {
    // The logged-out Claude probe returns null in discovery, so the catalog has
    // exactly one provider: one read member row and one separate write row.
    const { container } = mountDraftPanel([codex], ["codex"]);
    const facts = driverFacts();

    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(container.querySelectorAll(".authorization-row").length).toBe(2);
    expect(facts.readSelects.length).toBe(1);
    expect(facts.writeSelects.length).toBe(1);
    expect(facts.readRows.length).toBe(1);
    expect(facts.readRows[0].instance).toBe("codex");
    expect(readAuthorizationAssertions(facts, { names: ["Codex"], budget: 4 })).toEqual({
      readControlMembers: true,
      readMemberRows: true,
      readMembersChecked: true,
      writeConsentStaysOff: true,
      readTurnsBudget: true,
    });
  });

  it("leaves no blanket panel-checkbox or bare-row count in the shared driver", () => {
    const source = driverSource();
    expect(source.includes('.authorization-panel input[type=checkbox]')).toBe(false);
    expect(source.includes("querySelectorAll('.authorization-row')")).toBe(false);
    expect(source.includes(AUTHORIZATION.readControl)).toBe(true);
    expect(source.includes(AUTHORIZATION.writeControl)).toBe(true);
    expect(source.includes(AUTHORIZATION.readRow)).toBe(true);
  });
});

describe("R2 preserved matrix, refusal pins and read payloads", () => {
  it("keeps every pinned scenario definition byte-identical to itself", () => {
    for (const scenario of Object.values(SCENARIOS)) expect(validateScenario(scenario)).toBe(scenario);
    expect(SCENARIOS.a1.budget).toBe(4);
    expect(SCENARIOS.a1.widths).toEqual([860, 1020, 1440]);
    expect(SCENARIOS.a1.behavior.turns).toEqual({ codex: ["codex-tool-success"], claude: ["claude-carry-out-delayed"] });
    // a3 still expresses unavailability through the stub probe response only.
    expect(SCENARIOS.a3.widths).toEqual([1020]);
    expect(SCENARIOS.a3.behavior.probes.claude).toBe("claude-probe-unavailable");
    expect(SCENARIOS.a3.behavior.probes.codex).toBe("codex-probe-authenticated");
    expect(SCENARIOS.a3.behavior.turns).toEqual({ codex: [], claude: [] });
  });

  it("keeps the read payload assertions green and the new no-write facts fail-closed", () => {
    const readPayload = {
      ledger: {
        "coordinate-plan-a": { ok: true, messageDispatched: true, text: "Bounded plan." },
        "coordinate-review-b": { ok: true, messageDispatched: true, text: "The plan can be carried out.\nVERDICT: carry-out" },
      },
      invocations: [
        { identity: "codex", invocationType: "turn", behaviorId: "codex-tool-success" },
        { identity: "claude", invocationType: "turn", behaviorId: "claude-carry-out-delayed" },
        ...["codex", "claude"].flatMap(identity => Array.from({ length: 3 }, () => ({ identity, invocationType: "probe", behaviorId: `${identity}-probe-authenticated` }))),
      ],
      claims: ["claim-coordinate-plan-a", "claim-coordinate-review-b"], unconsumedGrants: [], health: null,
      records: [{ verdict: "checked", planText: "Bounded plan.", reviewText: "The plan can be carried out.\nVERDICT: carry-out", planningHarness: "Codex", reviewHarness: "Claude", executionText: null, auditText: null, executionHarness: null, auditHarness: null }],
    };
    expect(Object.values(artifactAssertions(readPayload)).every(Boolean)).toBe(true);
    expect(artifactAssertions(readPayload).readRolesOnly).toBe(true);
    expect(artifactAssertions(readPayload).noWriteFactsInRecord).toBe(true);
    // A fabricated write fact, writer role or missing write-member count must
    // never pass: the same fail-closed shape the old tests used.
    const executed = { ...readPayload, records: [{ ...readPayload.records[0], executionText: "Edited add.mjs", executionHarness: "Codex" }] };
    expect(artifactAssertions(executed).noWriteFactsInRecord).toBe(false);
    const writerRole = { ...readPayload, ledger: { ...readPayload.ledger, "coordinate-execute-c": { ok: true, messageDispatched: true, text: "Edited add.mjs" } } };
    expect(artifactAssertions(writerRole).readRolesOnly).toBe(false);
    expect(artifactAssertions({ ...readPayload, records: [] }).noWriteFactsInRecord).toBe(false);
  });
});
