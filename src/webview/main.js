// Webview main script
// Runs inside the VS Code WebView panel — no build step, plain vanilla JS.

(function () {
  'use strict';

  const vscodeApi = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string, status: string}>} */
  let sessions = [];

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string, status: string}>} */
  let historySessions = [];

  let historyOpen = false;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let previewTimer = null;

  // ── DOM References ────────────────────────────────────────────────────────

  let tabStrip;
  let historyToggle;
  let historyPanel;
  let previewEl;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * @param {string} isoString
   * @returns {string}
   */
  function formatRelativeTime(isoString) {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    if (isNaN(then)) { return ''; }
    const diffSec = Math.floor((now - then) / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr  = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr  / 24);
    if (diffSec < 60)  { return 'just now'; }
    if (diffMin < 60)  { return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`; }
    if (diffHr  < 24)  { return diffHr  === 1 ? '1 hour ago'   : `${diffHr} hours ago`; }
    if (diffDay < 30)  { return diffDay === 1 ? '1 day ago'    : `${diffDay} days ago`; }
    return new Date(isoString).toLocaleDateString();
  }

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

    // Measure off-screen before placing
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

  // ── Tab builder ───────────────────────────────────────────────────────────

  /**
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildTab(session) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.sessionId = session.sessionId;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '0');
    tab.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    const statusEl = document.createElement('span');
    statusEl.className = 'status-indicator status-' + (session.status || 'idle');
    statusEl.setAttribute('title',
      session.status === 'active'  ? 'Running' :
      session.status === 'waiting' ? 'Waiting for response' : '');

    const textEl = document.createElement('div');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';
    textEl.appendChild(titleEl);

    if (session.projectName) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'tab-badge';
      badgeEl.textContent = session.projectName;
      textEl.appendChild(badgeEl);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', 'Remove from tab bar');
    closeBtn.setAttribute('title', 'Remove from tab bar');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      vscodeApi.postMessage({ type: 'removeTab', sessionId: session.sessionId });
    });

    tab.appendChild(statusEl);
    tab.appendChild(textEl);
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.target === closeBtn) { return; }
        event.preventDefault();
        vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
      }
    });

    tab.addEventListener('mouseenter', function () {
      previewTimer = setTimeout(function () {
        vscodeApi.postMessage({ type: 'getSessionPreview', sessionId: session.sessionId });
      }, 250);
    });

    tab.addEventListener('mouseleave', function () {
      clearTimeout(previewTimer);
      hidePreview();
    });

    return tab;
  }

  // ── History item builder ──────────────────────────────────────────────────

  /**
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildHistoryItem(session) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('tabindex', '0');
    item.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    const textEl = document.createElement('div');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';
    textEl.appendChild(titleEl);

    if (session.projectName) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'tab-badge';
      badgeEl.textContent = session.projectName;
      textEl.appendChild(badgeEl);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'history-time';
    timeEl.textContent = formatRelativeTime(session.updatedAt);
    textEl.appendChild(timeEl);

    item.appendChild(textEl);

    const activate = () => {
      vscodeApi.postMessage({ type: 'addFromHistory', sessionId: session.sessionId });
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    return item;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function renderTabs() {
    if (!tabStrip) { return; }
    tabStrip.innerHTML = '';
    if (sessions.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'tab-placeholder';
      placeholder.textContent = 'No active sessions — click + to start one';
      tabStrip.appendChild(placeholder);
      return;
    }
    sessions.forEach(session => tabStrip.appendChild(buildTab(session)));
  }

  function renderHistory() {
    if (!historyPanel) { return; }
    historyPanel.innerHTML = '';
    if (historySessions.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tab-placeholder';
      empty.textContent = 'No past sessions found';
      historyPanel.appendChild(empty);
      return;
    }
    historySessions.forEach(session => historyPanel.appendChild(buildHistoryItem(session)));
  }

  function setHistoryOpen(open) {
    historyOpen = open;
    if (!historyToggle || !historyPanel) { return; }
    historyToggle.textContent = open ? 'History ▼' : 'History ▶';
    historyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    historyPanel.hidden = !open;
    if (open) {
      vscodeApi.postMessage({ type: 'loadHistory' });
    } else {
      vscodeApi.postMessage({ type: 'closeHistory' });
    }
  }

  // ── Message handling ─────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }

    switch (message.type) {
      case 'updateSessions':
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        renderTabs();
        break;
      case 'updateHistory':
        historySessions = Array.isArray(message.sessions) ? message.sessions : [];
        renderHistory();
        break;
      case 'sessionPreview': {
        const tabEl = tabStrip &&
          tabStrip.querySelector('[data-session-id="' + message.sessionId + '"]');
        if (tabEl && tabEl.matches(':hover')) {
          showPreview(message.projectPath || '', message.exchanges || [], tabEl);
        }
        break;
      }
    }
  });

  // ── Initialization ───────────────────────────────────────────────────────

  function init() {
    tabStrip      = document.getElementById('tab-strip');
    historyToggle = document.getElementById('history-toggle');
    historyPanel  = document.getElementById('history-panel');
    previewEl     = document.getElementById('session-preview');

    const newBtn = document.getElementById('new-session-btn');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'newSession' });
      });
    }

    if (historyToggle) {
      historyToggle.addEventListener('click', () => {
        setHistoryOpen(!historyOpen);
      });
    }

    renderTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); vscodeApi.postMessage({ type: 'ready' }); });
  } else {
    init();
    vscodeApi.postMessage({ type: 'ready' });
  }
}());
