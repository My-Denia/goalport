// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DEMO_SNAPSHOT, EMPTY_SNAPSHOT, type CoreSnapshot } from './types';
import type { CoreCommand } from './ipc';

const base = (): CoreSnapshot => ({ ...DEMO_SNAPSHOT, preview: false, decisions: [], productConversation: {
  items: [], title: 'Check the build', runtime: { state: 'selected', provider: 'codex', name: 'Codex' },
  turn: { state: 'idle', canSend: true, canStop: false }
} });
function mount(initial: CoreSnapshot, handle?: (request: CoreCommand) => Promise<CoreSnapshot>) {
  let live = initial;
  const command = vi.fn(async (request: CoreCommand) => {
    live = handle ? await handle(request) : live;
    return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: live };
  });
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = { snapshot: async () => live, command, startCore: async () => live, openInVsCode: async () => undefined };
  render(<App />);
  return command;
}
afterEach(() => { cleanup(); delete window.goalportCore; delete window.__GOALPORT_ELECTRON__; });

describe('conversation-first product boundary', () => {
  it('uses one first-send command and displays one user message without naming', async () => {
    const fresh = { ...EMPTY_SNAPSHOT, connection: 'connected' as const, runtimes: DEMO_SNAPSHOT.runtimes };
    let settle!: (snapshot: CoreSnapshot) => void;
    const command = mount(fresh, () => new Promise(resolve => { settle = resolve; }));
    const input = await screen.findByRole('textbox', { name: 'Message composer' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /goal title|goal name/i })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project folder' }), { target: { value: 'C:/fixture' } });
    fireEvent.change(input, { target: { value: 'Check the build and explain the failure.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Runtime' }));
    fireEvent.click(screen.getByRole('option', { name: /codex/i }));
    const send = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].messageType).toBe('start_conversation');
    const next = base();
    next.productConversation!.items = [{ id: 'message-internal-id', kind: 'user-message', body: 'Check the build and explain the failure.' }];
    settle(next);
    await screen.findByText('Check the build and explain the failure.');
    expect(document.querySelectorAll('[data-kind="user-message"]')).toHaveLength(1);
    expect(command.mock.calls.map(([r]) => r.messageType)).toEqual(['start_conversation']);
    expect(screen.queryByText(/stable command identity|Message recorded|receipt committed/)).toBeNull();
  });

  it('never offers Stop solely because an Attempt is active', async () => {
    mount(base());
    await screen.findByRole('textbox', { name: 'Message composer' });
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('replaces Send with Stop only for a live stoppable turn, then keeps Runtime', async () => {
    const live = base(); live.productConversation!.turn = { state: 'running', canSend: false, canStop: true };
    const command = mount(live, async request => {
      const next = base();
      if (request.messageType === 'interrupt') {
        next.attempt = { ...next.attempt, state: 'failed' };
        next.productConversation!.turn = { state: 'stopped', canSend: true, canStop: false };
      }
      return next;
    });
    fireEvent.click(await screen.findByRole('button', { name: /stop the running/i }));
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    await screen.findByText('Stopped');
    expect(screen.getByText('Codex')).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Message composer' });
    fireEvent.change(input, { target: { value: 'Continue here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(command.mock.calls.map(([r]) => r.messageType)).toEqual(['interrupt', 'conversation_send']));
  });

  it('keeps selected Runtime visible while uncertainty prevents Send', async () => {
    const held = base(); held.productConversation!.runtime.state = 'unavailable';
    held.productConversation!.turn = { state: 'uncertain', canSend: false, canStop: false, reason: 'Background work remains unconfirmed.' };
    mount(held);
    expect(await screen.findByText('Codex')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message composer' }), { target: { value: 'continue' } });
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('No Runtime selected')).toBeNull();
  });

  it('has no raw fallback when a legacy Core omits the product model', async () => {
    mount({ ...base(), productConversation: null, timeline: [{ id: 'raw', kind: 'attempt', eventKind: 'attempt.created', actor: 'Core', body: 'attempt-secret-id', title: 'COMMITTED', timestamp: '1789800000000' }] });
    await screen.findByText('Conversation view unavailable');
    expect(screen.queryByText('attempt-secret-id')).toBeNull();
    expect(screen.queryByText('COMMITTED')).toBeNull();
  });

  it('separates session facts from menu-only diagnostics and preserves raw facts there', async () => {
    const snapshot = base(); snapshot.attempt.id = 'attempt-' + 'x'.repeat(200);
    mount(snapshot);
    fireEvent.click(await screen.findByRole('button', { name: 'Open details panel' }));
    const details = screen.getByRole('complementary', { name: 'Session details' });
    expect(details.textContent).not.toContain(snapshot.attempt.id);
    expect(details.textContent).not.toMatch(/COMMITTED|CLAIM|session hash|CURRENT RESPONSIBILITY/);
    expect(within(details).queryByText(/Advanced diagnostics/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Application menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Developer diagnostics' }));
    const diagnostics = screen.getByRole('region', { name: 'Developer diagnostics' });
    expect(diagnostics.textContent).toContain(snapshot.attempt.id);
    expect(within(diagnostics).getAllByRole('button', { name: /copy/i }).length).toBeGreaterThan(0);
  });

  it('shows permission inline and does not allow an action missing details', async () => {
    const snapshot = base(); snapshot.decisions = [{ id: 'permission-private', title: 'Codex wants your approval', kind: 'permission', facts: ['Action details unavailable'], recommendation: '', defaultBehavior: 'Keep waiting', state: 'pending', actionKnown: false }];
    mount(snapshot);
    const approval = await screen.findByRole('region', { name: 'Decision Inbox' });
    expect((within(approval).getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(approval).getByRole('button', { name: 'Decline permission' }) as HTMLButtonElement).disabled).toBe(false);
    expect(approval.textContent).not.toContain('permission-private');
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});
