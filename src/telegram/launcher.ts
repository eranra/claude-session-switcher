/**
 * Starting and focusing sessions in *this* window, on behalf of a Telegram command.
 *
 * The one place in the feature that talks to `vscode.commands`, so everything else stays testable
 * without an extension host.
 *
 * ## Why a new session cannot be confirmed
 *
 * Neither Claude nor Bob returns a session id when told to open a conversation — Claude's
 * `primaryEditor.open` opens a panel, and the id appears only once the CLI writes its first
 * transcript record. So "start a session" is genuinely fire-and-forget, and the honest report is
 * that the window was opened, not that a session exists. The session shows up in the panel and in
 * Telegram within a poll or two, gets its own topic from whichever window owns it, and is
 * controllable from then on.
 *
 * Claiming more than that would be worse than saying less: a confirmation that a session started,
 * followed by no topic appearing, is harder to diagnose than being told to expect it shortly.
 */

import * as vscode from 'vscode';
import type { SessionLauncher } from './applyCommand';

/** Focus behaviour is shared with the panel, so it is injected rather than duplicated here. */
export interface FocusFn {
  (sessionId: string, source: string): Promise<boolean>;
}

export class VsCodeSessionLauncher implements SessionLauncher {
  constructor(
    private readonly log: (msg: string) => void,
    private readonly focusFn?: FocusFn,
  ) {}

  async launch(
    source: 'claude' | 'bob', workspace: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const name = workspace.split(/[/\\]/).pop() ?? workspace;
    try {
      if (source === 'claude') {
        // `primaryEditor.open` with no session id creates a fresh panel. The alternative,
        // `claude-vscode.newConversation`, only notifies panels that are already open and does
        // nothing when none is — see the note on sessionSitter.newSession.
        await vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
      } else {
        const ext = vscode.extensions.getExtension('IBM.bob-code');
        if (!ext) { return { ok: false, detail: 'Bob is not installed in that window.' }; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (ext.isActive ? ext.exports : await ext.activate()) as any;
        if (typeof api?.startTask !== 'function') {
          return { ok: false, detail: 'Bob is installed but exposes no startTask API.' };
        }
        await api.startTask();
      }
    } catch (err) {
      this.log(`remote control: launch ${source} in ${workspace} failed: ${String(err)}`);
      return { ok: false, detail: `Could not start a ${source} session in ${name}: ${String(err)}` };
    }
    this.log(`remote control: opened a new ${source} session in ${workspace}`);
    return {
      ok: true,
      detail: `Opened a new ${source} session in ${name}. Its topic appears once it writes its `
        + 'first message.',
    };
  }

  async focus(sessionId: string, source: string): Promise<boolean> {
    if (this.focusFn !== undefined) {
      try {
        return await this.focusFn(sessionId, source);
      } catch (err) {
        this.log(`remote control: focus ${sessionId} failed: ${String(err)}`);
        return false;
      }
    }
    // Without the panel's focus helper, the best available action for Claude is to open the
    // session's own editor panel by id.
    if (source !== 'claude') { return false; }
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', { sessionId });
      return true;
    } catch (err) {
      this.log(`remote control: focus ${sessionId} failed: ${String(err)}`);
      return false;
    }
  }
}
