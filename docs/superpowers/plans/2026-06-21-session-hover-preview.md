# Session Hover Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a floating card with the last 2–3 conversation exchanges (user + assistant) when the user hovers a session row for 250ms.

**Architecture:** The webview sends a `getSessionPreview` message after a 250ms hover-intent delay; the extension host reads the JSONL tail and returns recent exchanges; the webview renders a fixed-positioned overlay card anchored to the hovered row.

**Tech Stack:** TypeScript (VS Code extension host), Vanilla JS + CSS (webview), Vitest (tests), Node.js `fs` for JSONL reads.

## Global Constraints

- No build step for webview code — `src/webview/main.js` and `src/webview/styles.css` are served as-is.
- All VS Code CSS variables must have a fallback value (some themes don't define every variable).
- Test command: `npm test` (runs `vitest run`).
- TypeScript compile check: `npm run compile`.
- Tests live in `src/test/` and use Vitest with real temp files (no filesystem mocks).

---

### Task 1: `MessageExchange` interface, `_sessionFilePaths` tracking, and `getRecentExchanges()` in `SessionManager.ts`

**Files:**
- Modify: `src/SessionManager.ts`
- Test: `src/test/SessionManager.test.ts`

**Interfaces:**
- Produces: `export interface MessageExchange { role: 'user' | 'assistant'; text: string; timestamp?: string; }`
- Produces: `SessionManager.getRecentExchanges(sessionId: string): Promise<MessageExchange[]>`

---

- [ ] **Step 1: Write the failing tests**

Append to `src/test/SessionManager.test.ts` — below the existing `describe` block:

```typescript
describe('SessionManager.getRecentExchanges', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sm-preview-'));
    sm = new SessionManager(makeContext());
    (sm as unknown as { _projectsDir: string })._projectsDir = tmpDir;
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: seed the internal file-path map the same way a real scan would.
  function seedPath(sessionId: string, filePath: string) {
    (sm as unknown as { _sessionFilePaths: Map<string, string> })
      ._sessionFilePaths.set(sessionId, filePath);
  }

  it('returns [] for an unknown session id', async () => {
    const result = await sm.getRecentExchanges('does-not-exist');
    expect(result).toEqual([]);
  });

  it('returns user and assistant exchanges in chronological order', async () => {
    const id = 'preview-order';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'First question' }, timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'First answer' }] }, timestamp: '2024-01-01T00:00:01.000Z' },
      { type: 'user', message: { content: 'Second question' }, timestamp: '2024-01-01T00:00:02.000Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Second answer' }] }, timestamp: '2024-01-01T00:00:03.000Z' },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', text: 'First question', timestamp: '2024-01-01T00:00:00.000Z' });
    expect(result[1]).toMatchObject({ role: 'assistant', text: 'First answer' });
    expect(result[2]).toMatchObject({ role: 'user', text: 'Second question' });
    expect(result[3]).toMatchObject({ role: 'assistant', text: 'Second answer' });
  });

  it('returns at most 6 records (3 user + 3 assistant)', async () => {
    const id = 'preview-cap';
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ type: 'user', message: { content: `Question ${i}` } });
      lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `Answer ${i}` }] } });
    }
    const file = await writeTempJsonl(tmpDir, id, lines);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(6);
    // Should be the LAST 6 records (most recent 3 pairs)
    expect(result[0]).toMatchObject({ role: 'user', text: 'Question 2' });
  });

  it('skips tool_use and tool_result records', async () => {
    const id = 'preview-skip-tools';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Run a command' } },
      { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done!' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(2);
    expect(result.every(r => r.role === 'user' || r.role === 'assistant')).toBe(true);
  });

  it('skips assistant records that contain only tool_use blocks (no text)', async () => {
    const id = 'preview-skip-tool-only-assistant';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Do something' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ role: 'assistant', text: 'All done.' });
  });

  it('truncates user text longer than 150 chars', async () => {
    const id = 'preview-trunc-user';
    const longText = 'U'.repeat(200);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: longText } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].text).toBe('U'.repeat(150) + '…');
  });

  it('truncates assistant text longer than 250 chars', async () => {
    const id = 'preview-trunc-assistant';
    const longText = 'A'.repeat(300);
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'ask' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    const assistantEntry = result.find(r => r.role === 'assistant');
    expect(assistantEntry?.text).toBe('A'.repeat(250) + '…');
  });

  it('handles assistant with plain string content (not array)', async () => {
    const id = 'preview-string-assistant';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: 'Hi there' } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result.find(r => r.role === 'assistant')?.text).toBe('Hi there');
  });

  it('omits timestamp when not present in the record', async () => {
    const id = 'preview-no-ts';
    const file = await writeTempJsonl(tmpDir, id, [
      { type: 'user', message: { content: 'No timestamp here' } },
    ]);
    seedPath(id, file);
    const result = await sm.getRecentExchanges(id);
    expect(result[0].timestamp).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "getRecentExchanges|FAIL|TypeError"
```

Expected: failures like `TypeError: sm.getRecentExchanges is not a function`

- [ ] **Step 3: Add `timestamp` to `JsonlRecord`, add `MessageExchange` interface, add `_sessionFilePaths` map**

In `src/SessionManager.ts`:

**3a.** Add `timestamp?: string` to `JsonlRecord` (around line 20):
```typescript
interface JsonlRecord {
  type?: string;
  cwd?: string;
  aiTitle?: string;
  timestamp?: string;   // ← add this line
  message?: {
    content?: string | ContentBlock[];
  };
}
```

**3b.** Add the exported `MessageExchange` interface after `ClaudeSession` (around line 13):
```typescript
export interface MessageExchange {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}
```

**3c.** Add `_sessionFilePaths` as a private field on `SessionManager` (inside the class body, with the other private fields around line 88):
```typescript
private _sessionFilePaths = new Map<string, string>();
```

**3d.** Clear the map at the start of `_scanSessions()` (first line of the method body, around line 153):
```typescript
private async _scanSessions(): Promise<ClaudeSession[]> {
  const sessions: ClaudeSession[] = [];
  this._sessionFilePaths.clear();   // ← add this line
  // ... rest unchanged
```

**3e.** Populate the map in `_parseSessionFile()` just before the `return` statement (around line 279):
```typescript
      this._sessionFilePaths.set(sessionId, filePath);
      return { sessionId, projectName, projectPath, title, updatedAt, status };
```

- [ ] **Step 4: Implement `getRecentExchanges()`**

Add the following public method to the `SessionManager` class, after `getSessions()` (around line 133):

```typescript
async getRecentExchanges(sessionId: string): Promise<MessageExchange[]> {
  const filePath = this._sessionFilePaths.get(sessionId);
  if (!filePath) { return []; }

  let stat: { size: number };
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return [];
  }

  const TAIL = 32768;
  const offset = Math.max(0, stat.size - TAIL);
  const size = stat.size - offset;
  const buf = Buffer.alloc(size);

  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, size, offset);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const lines = chunk.split('\n');
    const collected: MessageExchange[] = [];

    for (let i = lines.length - 1; i >= 0 && collected.length < 6; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) { continue; }
      try {
        const record = JSON.parse(trimmed) as JsonlRecord;

        if (record.type === 'user') {
          const content = record.message?.content;
          let text: string | null = null;
          if (typeof content === 'string' && content.trim().length > 0) {
            text = content.trim();
          } else if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                text = b.text.trim();
                break;
              }
            }
          }
          if (text !== null) {
            const truncated = text.length > 150 ? text.slice(0, 150) + '…' : text;
            collected.push({ role: 'user', text: truncated, timestamp: record.timestamp });
          }

        } else if (record.type === 'assistant') {
          const content = record.message?.content;
          let text: string | null = null;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                text = b.text.trim();
                break;
              }
            }
          } else if (typeof content === 'string' && content.trim().length > 0) {
            text = content.trim();
          }
          if (text !== null) {
            const truncated = text.length > 250 ? text.slice(0, 250) + '…' : text;
            collected.push({ role: 'assistant', text: truncated, timestamp: record.timestamp });
          }
        }
      } catch {
        // Malformed line — skip
      }
    }

    return collected.reverse();
  } finally {
    await fh.close();
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: all `getRecentExchanges` tests pass. No regressions in existing tests.

- [ ] **Step 6: Compile**

```bash
npm run compile 2>&1
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/SessionManager.ts src/test/SessionManager.test.ts
git commit -m "feat: add MessageExchange interface and getRecentExchanges() to SessionManager"
```

---

### Task 2: `getSessionPreview` message handler + `#session-preview` overlay div

**Files:**
- Modify: `src/SessionSwitcherViewProvider.ts`

**Interfaces:**
- Consumes: `SessionManager.getRecentExchanges(sessionId: string): Promise<MessageExchange[]>` (from Task 1)
- Consumes: `SessionManager.getSessions(): ClaudeSession[]` (already exists)
- Produces: webview message `{ type: 'sessionPreview', sessionId, projectPath, exchanges }` in response to `{ type: 'getSessionPreview', sessionId }`

---

- [ ] **Step 1: Add `MessageExchange` to the import in `SessionSwitcherViewProvider.ts`**

Find the existing import at the top of the file (line 7):
```typescript
import { SessionManager, ClaudeSession, getActiveSessionIds, readActiveLockFiles, getIPCSocketForPid } from './SessionManager';
```

Change it to:
```typescript
import { SessionManager, ClaudeSession, MessageExchange, getActiveSessionIds, readActiveLockFiles, getIPCSocketForPid } from './SessionManager';
```

- [ ] **Step 2: Add the `getSessionPreview` message handler**

In `onDidReceiveMessage`, after the existing `case 'ready':` block (around line 101), add:

```typescript
          case 'getSessionPreview': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId || !this._view) { break; }
            const exchanges: MessageExchange[] = await this._sessionManager.getRecentExchanges(sessionId);
            const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
            void this._view.webview.postMessage({
              type: 'sessionPreview',
              sessionId,
              projectPath: session?.projectPath ?? '',
              exchanges,
            });
            break;
          }
```

- [ ] **Step 3: Add `#session-preview` div to the HTML template**

In `_getHtmlForWebview`, find the closing `</div>` that closes `#tab-bar` (around line 329) and add the overlay div between it and the `<script>` tag:

```html
  </div>
  <div id="session-preview" hidden></div>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
```

- [ ] **Step 4: Compile**

```bash
npm run compile 2>&1
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/SessionSwitcherViewProvider.ts
git commit -m "feat: wire getSessionPreview message handler in SessionSwitcherViewProvider"
```

---

### Task 3: Frontend — hover-intent, preview card rendering, and CSS styles

**Files:**
- Modify: `src/webview/main.js`
- Modify: `src/webview/styles.css`

**Interfaces:**
- Consumes: webview message `{ type: 'sessionPreview', sessionId: string, projectPath: string, exchanges: Array<{role, text, timestamp?}> }` (from Task 2)
- Consumes: existing `formatRelativeTime(isoString)` in `main.js`

---

- [ ] **Step 1: Add module-level state and DOM reference for the preview card**

In `src/webview/main.js`, in the `// ── State` section (around line 17), add:
```js
  /** @type {ReturnType<typeof setTimeout> | null} */
  let previewTimer = null;
```

In the `// ── DOM References` section (around line 21), add:
```js
  let previewEl;
```

- [ ] **Step 2: Add `showPreview` and `hidePreview` helper functions**

In `src/webview/main.js`, in the `// ── Helpers` section after `formatRelativeTime` (around line 44), add:

```js
  /**
   * @param {string} projectPath
   * @param {Array<{role: string, text: string, timestamp?: string}>} exchanges
   * @param {HTMLElement} anchorEl
   */
  function showPreview(projectPath, exchanges, anchorEl) {
    if (!previewEl) { return; }

    previewEl.innerHTML = '';

    if (projectPath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'preview-path';
      pathEl.textContent = projectPath;
      previewEl.appendChild(pathEl);
    }

    exchanges.forEach(function (exchange) {
      const exchangeEl = document.createElement('div');
      exchangeEl.className = 'preview-exchange';

      const metaEl = document.createElement('div');
      metaEl.className = 'preview-meta';

      const roleEl = document.createElement('span');
      roleEl.className = 'preview-role ' +
        (exchange.role === 'user' ? 'preview-role-user' : 'preview-role-assistant');
      roleEl.textContent = exchange.role === 'user' ? 'You' : 'Claude';
      metaEl.appendChild(roleEl);

      if (exchange.timestamp) {
        const timeEl = document.createElement('span');
        timeEl.className = 'preview-time';
        timeEl.textContent = formatRelativeTime(exchange.timestamp);
        metaEl.appendChild(timeEl);
      }

      const textEl = document.createElement('div');
      textEl.className = 'preview-text';
      textEl.textContent = exchange.text;

      exchangeEl.appendChild(metaEl);
      exchangeEl.appendChild(textEl);
      previewEl.appendChild(exchangeEl);
    });

    // Measure height off-screen before final placement
    previewEl.style.top = '-9999px';
    previewEl.style.left = '-9999px';
    previewEl.hidden = false;

    const rect = anchorEl.getBoundingClientRect();
    const cardHeight = previewEl.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;

    previewEl.style.left = rect.left + 'px';
    if (spaceBelow >= cardHeight + 4) {
      previewEl.style.top = (rect.bottom + 4) + 'px';
    } else {
      previewEl.style.top = Math.max(4, rect.top - cardHeight - 4) + 'px';
    }
  }

  function hidePreview() {
    if (!previewEl) { return; }
    previewEl.hidden = true;
    previewEl.innerHTML = '';
  }
```

- [ ] **Step 3: Add hover-intent listeners inside `buildTab()`**

In `src/webview/main.js`, inside `buildTab(session)`, after the existing `tab.addEventListener('keydown', ...)` block (around line 104), add:

```js
    tab.addEventListener('mouseenter', function () {
      previewTimer = setTimeout(function () {
        vscodeApi.postMessage({ type: 'getSessionPreview', sessionId: session.sessionId });
      }, 250);
    });

    tab.addEventListener('mouseleave', function () {
      clearTimeout(previewTimer);
      hidePreview();
    });
```

- [ ] **Step 4: Add `sessionPreview` to the message handler switch**

In `src/webview/main.js`, inside the `window.addEventListener('message', ...)` switch (around line 204), add after the `case 'updateHistory':` block:

```js
      case 'sessionPreview': {
        const tabEl = tabStrip &&
          tabStrip.querySelector('[data-session-id="' + message.sessionId + '"]');
        if (tabEl && tabEl.matches(':hover')) {
          showPreview(message.projectPath || '', message.exchanges || [], tabEl);
        }
        break;
      }
```

- [ ] **Step 5: Wire `previewEl` in `init()`**

In `src/webview/main.js`, inside `init()` after the `historyPanel = ...` line (around line 222), add:

```js
    previewEl = document.getElementById('session-preview');
```

- [ ] **Step 6: Add CSS for the preview card**

Append to the end of `src/webview/styles.css`:

```css
/* ── Session Preview Card ───────────────────────────────────────────────── */

#session-preview {
  position: fixed;
  z-index: 100;
  width: calc(100vw - 8px);
  max-width: 320px;
  background-color: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-tab-border, #444));
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  padding: 8px 0;
  pointer-events: none;
}

.preview-path {
  padding: 2px 10px 6px;
  font-size: 10px;
  opacity: 0.55;
  word-break: break-all;
  border-bottom: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-tab-border, #444));
  margin-bottom: 4px;
}

.preview-exchange {
  padding: 4px 10px;
}

.preview-exchange + .preview-exchange {
  border-top: 1px solid var(--vscode-list-inactiveFocusOutline, rgba(128, 128, 128, 0.15));
  margin-top: 4px;
  padding-top: 4px;
}

.preview-meta {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin-bottom: 2px;
}

.preview-role {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.preview-role-user {
  color: var(--vscode-charts-blue, #4fc1ff);
}

.preview-role-assistant {
  color: var(--vscode-charts-green, #4caf50);
}

.preview-time {
  font-size: 10px;
  opacity: 0.55;
}

.preview-text {
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 7: Run tests and compile**

```bash
npm test 2>&1 | tail -10 && npm run compile 2>&1
```

Expected: all tests pass, no TypeScript errors.

- [ ] **Step 8: Manual verification**

Reload the VS Code extension (`Developer: Reload Window` or press F5 to launch Extension Development Host). Open the Claude Session Switcher panel. Verify:

1. Hovering a session row for 250ms shows the floating card with project path and recent exchanges.
2. Moving the mouse away hides the card.
3. Quickly sweeping through rows does not trigger the card (the 250ms debounce prevents it).
4. If the session JSONL has no exchanges, only the project path row is shown.
5. Card flips above the row when near the bottom of the viewport.

- [ ] **Step 9: Commit**

```bash
git add src/webview/main.js src/webview/styles.css
git commit -m "feat: add session hover preview card with conversation exchanges"
```
