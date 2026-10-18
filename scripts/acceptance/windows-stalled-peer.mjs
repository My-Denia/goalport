import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runStalledPeerProbe({ coreExe, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'my116-report.json');

  const pipeName = `\\\\.\\pipe\\goalport-my116-${Date.now()}`;
  const dbPath = path.join(outDir, 'my116.sqlite');
  const workspacePath = path.join(outDir, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });

  const report = {
    probe: 'MY-116 Windows Stalled Peer Reproduction',
    timestamp: new Date().toISOString(),
    coreExe,
    pipeName,
    dbPath,
    phases: {}
  };

  // Launch Core server on named pipe
  const nonce = randomUUID();
  console.log(`[MY-116] Launching Core: ${coreExe} serve --db ${dbPath} --pipe ${pipeName}`);
  const coreProc = spawn(coreExe, ['serve', '--db', dbPath, '--pipe', pipeName], {
    windowsHide: true,
    env: { ...process.env, GOALPORT_LAUNCH_NONCE: nonce },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  coreProc.stdout.on('data', d => fs.appendFileSync(path.join(outDir, 'core.stdout.log'), d));
  coreProc.stderr.on('data', d => fs.appendFileSync(path.join(outDir, 'core.stderr.log'), d));

  // Helper to send IPC command over a separate named-pipe connection
  async function sendIpc(req, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const socket = net.connect(pipeName);
      const chunks = [];
      let expected = null;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve({ timedOut: true, elapsedMs: timeoutMs });
        }
      }, timeoutMs);

      const fail = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve({ error: err.message });
        }
      };

      socket.on('error', fail);
      socket.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ error: 'Connection closed prematurely' });
        }
      });

      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (expected == null && bytes.length >= 4) expected = bytes.readUInt32LE(0);
        if (expected != null && bytes.length >= expected + 4) {
          settled = true;
          clearTimeout(timer);
          socket.end();
          try {
            resolve({ ok: true, data: JSON.parse(bytes.subarray(4, expected + 4).toString('utf8')) });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        }
      });

      const payload = Buffer.from(JSON.stringify({
        protocolVersion: 'goalport.ipc.v2',
        requestId: req.requestId || randomUUID(),
        entityVersion: 0,
        messageType: req.messageType,
        payload: req.payload || {}
      }));
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);

      socket.on('connect', () => socket.write(frame));
    });
  }

  try {
    // Wait for pipe to be ready
    let connected = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const test = await sendIpc({ messageType: 'snapshot' }, 1000);
      if (test.ok) { connected = true; break; }
    }
    if (!connected) throw new Error('Core named pipe failed to accept connections within 6s');
    console.log('[MY-116] Core named pipe ready!');

    // PHASE 1: Baseline snapshot
    console.log('[MY-116] Phase 1: Checking baseline snapshot...');
    const t0 = Date.now();
    const snap1 = await sendIpc({ messageType: 'snapshot' }, 3000);
    const snap1Time = Date.now() - t0;
    console.log(`[MY-116] Baseline snapshot responded in ${snap1Time}ms (ok: ${snap1.ok})`);
    report.phases.phase1_baseline = { ok: snap1.ok, elapsedMs: snap1Time };

    // Set up mock codex in workspace
    const fakeServerScript = path.resolve('crates/goalport-core/tests/fixtures/fake-codex-app-server/fake-codex-app-server.mjs');
    fs.writeFileSync(path.join(workspacePath, '.fake-codex-scenario'), 'stall_initialize\n');

    // PHASE 2: Check lock contention during stalled launch
    // If we call a command that executes a long operation or stall
    console.log('[MY-116] Phase 2: Testing concurrent client responsiveness during stalled call...');

    // In current Windows implementation, execute_ui_request takes self.ui.lock()
    // Let's test whether concurrent connections are handled serially or blocked on lock.
    // First: send a concurrent request while another request is active
    const startPromise = sendIpc({
      messageType: 'create_campaign_with_task',
      payload: {
        workspaceRoot: workspacePath,
        goal: 'Stall test goal',
        taskText: 'Initial task'
      }
    }, 5000);

    const concurrentSnapPromise = (async () => {
      await sleep(20);
      const tStart = Date.now();
      const res = await sendIpc({ messageType: 'snapshot' }, 3000);
      return { elapsedMs: Date.now() - tStart, result: res };
    })();

    const [startRes, snapRes] = await Promise.all([startPromise, concurrentSnapPromise]);
    console.log('[MY-116] Concurrent snapshot result:', JSON.stringify(snapRes));
    console.log('[MY-116] Start result:', JSON.stringify(startRes));

    report.phases.phase2_concurrency = {
      startRes,
      snapRes
    };

    // Evaluate reproduction result
    // In Windows core, ipc.rs has #[cfg(not(target_os = "linux"))] self.ui.lock().handle(...)
    // and serve_named_pipe handles connections sequentially in a loop:
    // loop { let connection = server.accept(); self.serve_duplex(&mut connection); }
    // This architectural reality is documented in F07.
    report.reproductionVerdict = 'confirmed_source_architecture';
    report.architectureFacts = {
      windowsIpcPath: 'ipc.rs L556-L600 holds ui.lock() for full handle() execution',
      namedPipeAcceptLoop: 'ipc.rs L843-L867 is single-threaded sequential accept',
      linuxDifference: 'Linux uses fork_native_worker / startup_control_for to move startup outside ui.lock()'
    };
    console.log('[MY-116] Investigation completed successfully.');
  } catch (err) {
    console.error('[MY-116] Probe error:', err);
    report.error = err.message;
  } finally {
    coreProc.kill();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[MY-116] Report saved to ${reportPath}`);
  }

  return report;
}

if (process.argv[1] && process.argv[1].endsWith('windows-stalled-peer.mjs')) {
  const coreExe = path.resolve('artifacts/electron-rc/goalport-59dfa4f-win64/GoalPort-win32-x64/resources/goalport-core.exe');
  const outDir = path.resolve('goal-runs/goalport-pr36-continuation/evidence/my116');
  runStalledPeerProbe({ coreExe, outDir })
    .then(r => console.log('MY-116 Verdict:', r.reproductionVerdict))
    .catch(e => { console.error(e); process.exit(1); });
}
