import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SESSION_STATUSES } from '../sessionStatus';

// The webview toggles panel visibility via the `hidden` attribute
// (e.g. `historyPanel.hidden = !open` in main.js). Elements like
// #history-panel / #activity-panel also set `display: flex` in styles.css.
// An id selector (specificity 1,0,0) beats the UA stylesheet's
// `[hidden] { display: none }`, so without a defensive rule the panels
// never collapse. This test guards the defensive rule that makes the
// `hidden` attribute win.
describe('webview styles.css: hidden attribute is honored', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'styles.css'),
    'utf8',
  );

  it('has a [hidden] rule that forces display:none with !important', () => {
    // Strip comments and whitespace to make matching robust to formatting.
    const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/i;
    expect(normalized).toMatch(rule);
  });
});

// The webview is plain JS with no DOM in the test environment, so what is checkable here is the
// contract between the feed and the renderer: `recordToItem` produces `sessionName`/`host`, and
// main.js must read those exact names and style them. A silent rename on either side is what turns
// the line back into an unattributable row, which is the bug this feature exists to fix.
describe('webview: the activity row names its session and machine', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('reads the session name and host off the feed item', () => {
    expect(main).toContain('item.sessionName');
    expect(main).toContain('item.host');
  });

  it('styles the classes it puts them in', () => {
    expect(main).toContain('activity-session-name');
    expect(main).toContain('activity-session-host');
    expect(css).toMatch(/\.activity-session\s*\{/);
    expect(css).toMatch(/\.activity-session-name\s*\{/);
    expect(css).toMatch(/\.activity-session-host\s*\{/);
  });
});

// The webview is plain JS with no DOM under test, so what is checkable here is the contract
// between the three files that have to agree: the extension host renders the button, main.js
// looks it up by that exact id and posts the message the host handles, and styles.css styles the
// classes main.js puts on the elements. A rename on any one side is silent at runtime — the
// button simply does nothing, or the pill silently ignores its colour.
describe('webview: the sort control', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'SessionSitterViewProvider.ts'), 'utf8');

  it('renders the toolbar button main.js looks for', () => {
    expect(provider).toContain('id="sort-btn"');
    expect(main).toContain("getElementById('sort-btn')");
  });

  it('posts the message the extension host handles, under the name it handles it by', () => {
    expect(main).toContain("type: 'setSessionSort'");
    expect(provider).toContain("case 'setSessionSort'");
  });

  it('builds the menu from the modes the host sends, not from its own list', () => {
    expect(main).toContain('message.sortModes');
    expect(main).toContain('message.sortMode');
    expect(provider).toContain('sortModes: SESSION_SORT_MODES');
  });

  it('styles the button and the menu items it creates', () => {
    expect(main).toContain('session-sort-item');
    expect(main).toContain('session-sort-check');
    expect(css).toMatch(/#sort-btn\s*[,{]/);
    expect(css).toMatch(/\.session-sort-item\s*\{/);
    expect(css).toMatch(/\.session-sort-check\s*\{/);
  });
});

describe('webview: the coloured workspace pill', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('reads the colour pair the host resolved off the session row', () => {
    expect(main).toContain('session.workspaceColor');
    expect(main).toContain('.background');
    expect(main).toContain('.foreground');
  });

  it('styles the class it marks a coloured pill with', () => {
    expect(main).toContain('tab-badge--colored');
    expect(css).toMatch(/\.tab-badge--colored\s*\{/);
  });
});

// The webview is plain JS with no DOM under test, so what is checkable here is the contract between
// the three files that must agree about the six status states: `sessionStatus.ts` names them,
// main.js builds a class per state, and styles.css styles every class it builds. A state added on
// one side and forgotten on another is silent at runtime — the marker simply renders as an
// unstyled empty span, which looks like no status at all.
describe('webview: the six status markers', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  it('styles every state the status module defines', () => {
    for (const status of SESSION_STATUSES) {
      expect(css).toMatch(new RegExp(`\\.status-${status}\\b`));
    }
  });

  it('names every state in a tooltip, so no marker is unexplained', () => {
    // Four are matched by their own case label; `seen` and `dormant` share the switch's default
    // path, so they are checked by the text they produce.
    for (const status of ['approval', 'question', 'finished', 'working']) {
      expect(main).toContain(`case '${status}':`);
    }
    expect(main).toContain('you have read it');
    expect(main).toContain('No liveness signal');
  });

  it('builds the class name styles.css defines, from the session status', () => {
    expect(main).toContain("'status-indicator status-' + status");
  });

  it('gives the marker an accessible name — the shape is its only content', () => {
    expect(main).toContain("setAttribute('role', 'img')");
    expect(main).toContain("setAttribute('aria-label'");
  });

  it('animates only the working state', () => {
    // Motion reads as "busy, leave it alone", which is the wrong thing to say about a session
    // blocked waiting for you. Only `working` may move.
    const animated = [...css.matchAll(/\.status-([a-z]+)\s*\{([^}]*)\}/g)]
      .filter(m => /animation\s*:\s*[a-z]/.test(m[2]) && !/animation\s*:\s*none/.test(m[2]))
      .map(m => m[1]);
    expect(animated).toEqual(['working']);
  });

  it('honours prefers-reduced-motion', () => {
    const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(normalized).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // Inside that block, the spinner must actually be stopped.
    const block = normalized.slice(normalized.indexOf('prefers-reduced-motion'));
    expect(block).toMatch(/animation\s*:\s*none/);
  });

  it('separates seen from dormant by shape, not only by opacity', () => {
    // Both are quiet states, but they mean different things — "finished, you read it" versus
    // "nothing is happening, or we cannot tell". Two dim dots would rebuild the ambiguity the
    // six-state set exists to remove, so `dormant` must be an outline.
    const dormant = css.slice(css.indexOf('.status-dormant'));
    expect(dormant.slice(0, dormant.indexOf('}'))).toMatch(/border\s*:/);
  });
});

// ── The spinner has to survive being rebuilt ─────────────────────────────────
//
// `renderTabs()` clears the strip and recreates every row on every push, and a brand-new element
// starts its CSS animation at 0deg. The rows are pushed whenever `sessionsFingerprint` moves, which
// during a streaming session means every 250ms watcher debounce — Claude writes the transcript far
// faster than that. So the one state that animates is also the one rebuilt several times a second,
// and the ring was snapping back to 0 before it had turned a quarter. It reads as a ring that
// twitches in place rather than one that turns.
//
// The fix anchors the animation's phase to the wall clock with a negative `animation-delay`, so a
// fresh element picks up where the one it replaced left off. That only works while the delay and the
// CSS duration agree about the period, which is what these tests pin.
describe('webview: the working spinner is phase-anchored to the clock', () => {
  const dir = path.join(__dirname, '..', 'webview');
  const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

  /** The declared period of `.status-working`'s animation, in ms. */
  function cssSpinPeriodMs(): number {
    const block = css.slice(css.indexOf('.status-working'));
    const decl = block.slice(0, block.indexOf('}'));
    const match = /animation\s*:\s*spin\s+([\d.]+)(m?s)/.exec(decl);
    if (!match) { throw new Error('.status-working declares no spin animation'); }
    return match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * 1000;
  }

  it('sets a negative animation-delay on the working marker', () => {
    const fn = main.slice(main.indexOf('function buildStatusIndicator'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    // Negative, because that is what starts an animation mid-cycle rather than delaying it.
    expect(body).toMatch(/animationDelay\s*=\s*['"`]-/);
  });

  it('divides by the same period the stylesheet declares', () => {
    const declared = /SPIN_PERIOD_MS\s*=\s*(\d+)/.exec(main);
    expect(declared, 'main.js must name the spin period as SPIN_PERIOD_MS').not.toBeNull();
    // A mismatch is invisible in review and shows up only as a spinner that jumps on every push.
    expect(Number(declared![1])).toBe(cssSpinPeriodMs());
  });

  it('anchors only the state that animates', () => {
    // Every other marker is static by design — `approval` especially, where motion would say
    // "busy, leave it alone" about the one row that is waiting on you.
    const fn = main.slice(main.indexOf('function buildStatusIndicator'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/status\s*===\s*'working'/);
  });
});
