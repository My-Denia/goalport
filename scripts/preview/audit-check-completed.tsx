// Acceptance fixture for completed Pi review state.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeWorkspaceCheck } from '../../src/conversation/NativeWorkspaceCheck';
import { prepareNativeWorkspaceCheckMaterial } from '../../src/coordination/nativeWorkspaceCheck';
import '../../src/styles.css';

const target = { campaignId: 'campaign-1', attemptId: 'attempt-1', turnRequestId: 'turn-1' };
const pair = { provider: 'Denia', model: 'gemini-3.8-flash-high', useExistingCapacity: true as const };
const context = {
  reply: 'I fixed the coordination records saving logic.',
  replyTruncated: false,
  commands: [],
  commandsOmitted: 0,
  commandsTruncated: false,
  filesTruncated: false,
  comparisonUnavailable: false,
  olderTurnsOmitted: 0,
};
const material = prepareNativeWorkspaceCheckMaterial({
  contentObservation: {
    head: 'b'.repeat(40),
    paths: [{ path: 'electron/coordination-record.cjs', status: 'M', category: null, classification: 'selected' }],
    selectedDiff: 'diff --git a/electron/coordination-record.cjs b/electron/coordination-record.cjs\n+readRecordsStrict\n',
    selectedStatus: ' M electron/coordination-record.cjs\0',
    nativeReportedContext: context,
  },
  nativeReportedContext: context,
  capturedAt: '2026-11-02T12:00:00Z',
});

const completedJob: any = {
  jobId: '00000000-0000-4000-8000-000000000099',
  requestId: 'native-check-completed-req',
  goal: 'Review coordination records fix',
  workspacePath: 'C:\\workspace\\goalport',
  recordKind: 'native-workspace-check',
  nativeCheckTarget: target,
  nativeCheckMaterial: material,
  piCapacity: pair,
  state: 'completed',
  active: false,
  live: false,
  revoked: false,
  workerPid: null,
  readMaxTurns: 2,
  writeMaxTurns: null,
  counters: { readTurnsLeft: 1, writeTurnsLeft: null },
  pendingCommand: null,
  completedCommands: [],
  progress: null,
  outcome: {
    status: 'completed',
    report: {
      auditText:
        "The changes match what Codex reported: readRecordsStrict prevents data loss.\n\n### Findings\n- `readRecordsStrict` ensures `ENOENT` is the only safe empty history.\n- Corrupted or unreadable files abort save and protect existing data.",
    },
  },
};

const savedCheck: any = {
  requestId: 'native-check-earlier-req',
  nativeAssociation: true,
  nativeCheckTarget: { ...target, turnRequestId: 'turn-0' },
  nativeCheckMaterial: material,
  statusLabel: 'Independent workspace check returned',
  auditText: 'Earlier turn check: verified cleanly.',
  savedAt: '2026-11-02T11:00:00Z',
};

window.goalportCore = {
  nativeCheck: async (type: string) => ({
    ok: true,
    payload: type === 'coordination_list' ? { checks: [savedCheck] } : {},
  }),
} as never;

function Fixture() {
  const [askCodexMessage, setAskCodexMessage] = useState<string | null>(null);

  return (
    <div className="goalport-shell" style={{ minHeight: '100vh', background: 'var(--bg-app)' }}>
      <header className="titlebar" role="banner">
        <div className="titlebar-inner">
          <div className="titlebar-left">
            <span className="titlebar-app">GoalPort</span>
            <span className="titlebar-sep">/</span>
            <span className="titlebar-workspace">Review coordination records fix</span>
          </div>
        </div>
      </header>
      <main style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
        <h2>Conversation with Codex</h2>
        <div style={{ background: 'var(--bg-card)', padding: 16, borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <p><strong>Codex:</strong> I have updated the coordination record saver to preserve existing files on read errors.</p>
        </div>
        <NativeWorkspaceCheck
          campaignId="campaign-1"
          target={target}
          eligible={true}
          job={completedJob}
          onJob={() => {}}
          onBusy={() => {}}
          onAskCodex={(text) => setAskCodexMessage(text)}
        />
        {askCodexMessage ? (
          <div role="status" style={{ marginTop: 16, padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <strong>Composer draft set to:</strong>
            <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{askCodexMessage}</pre>
          </div>
        ) : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
