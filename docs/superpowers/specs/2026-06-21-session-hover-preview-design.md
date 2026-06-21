# Session Hover Preview

**Date:** 2026-06-21  
**Status:** Approved

## Goal

When the user hovers over a session row in the session list for 250ms, a floating card appears showing the last 2–3 user/assistant conversation exchanges with timestamps. This lets users quickly see what a session is working on and how recently it was active — without switching to it.

## Approach

Lazy-load on hover-intent (Option A): the webview sends a `getSessionPreview` message to the extension host only after the cursor has rested on a row for 250ms. The extension reads the JSONL tail, extracts recent exchanges, and posts them back. No extra data is sent on routine session list refreshes.

## Data Model

New interface exported from `SessionManager.ts`:

```typescript
export interface MessageExchange {
  role: 'user' | 'assistant';
  text: string;       // truncated: ≤150 chars for user, ≤250 for assistant
  timestamp?: string; // ISO string from the JSONL record if present
}
```

JSONL records carry `timestamp` fields. When absent (older records), the field is omitted and the UI shows no time for that entry.

## Components

### SessionManager.ts

1. Add `timestamp?: string` to the `JsonlRecord` interface.
2. Add `private _sessionFilePaths = new Map<string, string>()` — populated during each `_parseSessionFile` call (which already has the `filePath`). Cleared and rebuilt on every scan.
3. Add public method:

```typescript
async getRecentExchanges(sessionId: string): Promise<MessageExchange[]>
```

- Looks up the JSONL path from `_sessionFilePaths`. Returns `[]` if not found.
- Opens the file, reads the last 32 KB (same window as `_readStatus`).
- Scans lines backward, collecting records where `type === 'user'` or `type === 'assistant'`.
  - For `user`: extract text the same way `_parseSessionFile` does (string or first `type:'text'` block). Skip if empty.
  - For `assistant`: extract the first `type:'text'` content block. Skip tool-only responses.
- Stops once 6 records are collected (3 user + 3 assistant at most).
- Reverses the collected records into chronological order.
- Truncates: user text to 150 chars, assistant text to 250 chars (appends `…` if cut).
- Returns the resulting `MessageExchange[]`.

### SessionSwitcherViewProvider.ts

1. Add `getSessionPreview` case to `onDidReceiveMessage`:

```typescript
case 'getSessionPreview': {
  const sessionId = message.sessionId as string | undefined;
  if (!sessionId || !this._view) { break; }
  const exchanges = await this._sessionManager.getRecentExchanges(sessionId);
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

2. Add `#session-preview` div to the HTML template (inside `<body>`, after `#tab-bar`):

```html
<div id="session-preview" hidden></div>
```

### src/webview/main.js

**State:**
- `let previewTimer = null` — the 250ms hover-intent timer.
- `let previewVisible = false` — whether the card is currently shown.

**In `buildTab()`**, add after the existing event listeners:

```js
tab.addEventListener('mouseenter', () => {
  previewTimer = setTimeout(() => {
    vscodeApi.postMessage({ type: 'getSessionPreview', sessionId: session.sessionId });
  }, 250);
});
tab.addEventListener('mouseleave', () => {
  clearTimeout(previewTimer);
  hidePreview();
});
```

**`showPreview(sessionId, projectPath, exchanges, anchorEl)`:**
- Populates `#session-preview` with project path and exchange rows.
- Uses `getBoundingClientRect()` on `anchorEl` to position the card.
- Card is `position: fixed`. Default: top = `anchorRect.bottom + 4px`, left = `anchorRect.left`.
- Flip above if `anchorRect.bottom + cardHeight > window.innerHeight`.
- Sets `hidden = false`.

**`hidePreview()`:** sets `hidden = true`, clears content.

**Message handler** — add to the existing `switch`:

```js
case 'sessionPreview':
  // Find the tab element for this session and show the card anchored to it
  const tabEl = tabStrip.querySelector(`[data-session-id="${message.sessionId}"]`);
  if (tabEl && tabEl.matches(':hover')) {
    showPreview(message.sessionId, message.projectPath, message.exchanges, tabEl);
  }
  break;
```

### src/webview/styles.css

New `.session-preview` block:

- `position: fixed; z-index: 100`
- Width: `calc(100vw - 8px)`, max-width `320px`
- Background: `var(--vscode-editorHoverWidget-background)`
- Border: `1px solid var(--vscode-editorHoverWidget-border)`
- Border-radius, padding, box-shadow for legibility
- `.preview-path`: small muted project path row
- `.preview-exchange`: exchange block with role label + timestamp on one line, message text below
- `.preview-role-user` / `.preview-role-assistant`: color coding using VS Code vars

## Data Flow

```
hover 250ms
  → webview: getSessionPreview { sessionId }
  → extension: getRecentExchanges(sessionId)
     → reads ~/.claude/projects/**/<sessionId>.jsonl tail
     → returns MessageExchange[]
  → extension: sessionPreview { sessionId, projectPath, exchanges }
  → webview: showPreview(exchanges, anchorEl)
mouseleave
  → hidePreview()
```

## Edge Cases

- **Session not in `_sessionFilePaths`** (e.g. just removed): `getRecentExchanges` returns `[]`; webview receives an empty exchanges array and shows only the project path row.
- **JSONL has no text exchanges** (e.g. only tool calls): assistant entries with no text block are skipped; the card may show fewer than 3 pairs or none.
- **Hover leaves before response arrives**: `mouseleave` fires, `hidePreview()` runs. When the async `sessionPreview` message arrives, `tabEl` is checked via `querySelector`; the card is shown only if the element is still hovered — handled by checking `tabEl.matches(':hover')` before calling `showPreview`.
- **Near viewport bottom**: card flips above the row using the flip logic described above.
- **Timestamp absent**: the timestamp portion of the role/time line is omitted; layout still works.

## Files Changed

| File | Change |
|------|--------|
| `src/SessionManager.ts` | `MessageExchange` interface, `_sessionFilePaths` map, `getRecentExchanges()` |
| `src/SessionSwitcherViewProvider.ts` | `getSessionPreview` handler, `#session-preview` div in HTML |
| `src/webview/main.js` | hover-intent timers, `showPreview`/`hidePreview`, `sessionPreview` message handler |
| `src/webview/styles.css` | `.session-preview` card styles |
