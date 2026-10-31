'use strict';

/*
 * Voxa notch extras.
 *
 * Adds the quick rail, settings sheet, alerts panel, and media panel around
 * the locked notch kit. Nothing in this file changes notch-kit.css/js; every
 * control saves through the existing settings handler and the appearance is
 * applied to the kit through its public API.
 */
(function (global) {
  const SVG = (paths) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    settings: SVG('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'),
    chat: SVG('<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/>'),
    bell: SVG('<path d="M4 7a4 4 0 0 1 8 0v3l1.2 2H2.8L4 10z"/><path d="M6.5 13.2a1.6 1.6 0 0 0 3 0"/>'),
    music: SVG('<path d="M6 12V4l6-1v8"/><circle cx="4.6" cy="12.2" r="1.6"/><circle cx="10.6" cy="11.2" r="1.6"/>'),
    pause: SVG('<path d="M6 4v8M10 4v8"/>'),
    play: SVG('<path d="M5.5 3.8v8.4L12 8z"/>'),
    close: SVG('<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
    previous: SVG('<path d="M4 4v8M12 4L6 8l6 4z"/>'),
    next: SVG('<path d="M12 4v8M4 4l6 4-6 4z"/>'),
    trash: SVG('<path d="M3.5 5h9M6 5V3.5h4V5M5 5l.5 8h5L11 5"/>'),
    dashboard: SVG('<path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z"/>'),
    alert: SVG('<path d="M8 3.2 2.2 13h11.6z"/><path d="M8 6.8v2.6M8 11.3v.2"/>')
  };
  const PANEL_KINDS = ['settings', 'alerts', 'media'];
  const TABS = [
    ['look', 'Look'],
    ['voice', 'Voice'],
    ['assistant', 'Assistant'],
    ['system', 'System']
  ];
  const NOT_AVAILABLE = 'Unavailable';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pointIn(rect, x, y) {
    return Boolean(rect) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function expanded(rect, by) {
    return {
      left: rect.left - by,
      right: rect.right + by,
      top: rect.top - by,
      bottom: rect.bottom + by
    };
  }

  function rectPayload(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function timeLabel(ts) {
    const date = new Date(Number(ts) || Date.now());
    try {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'turn': return 'Turn';
      case 'download': return 'Download';
      case 'media': return 'Media';
      case 'error': return 'Error';
      case 'approval': return 'Approval';
      default: return 'System';
    }
  }

  function optionList(values, labels) {
    return values.map((value) => ({
      value,
      label: Array.isArray(labels) ? labels[value] : (labels && labels[value]) || String(value)
    }));
  }

  function mount(ctx) {
    const api = ctx.api;
    const notch = ctx.notch;
    const root = ctx.root;
    const getSnapshot = typeof ctx.getSnapshot === 'function' ? ctx.getSnapshot : () => ({});
    const onRectsChanged = typeof ctx.onRectsChanged === 'function' ? ctx.onRectsChanged : () => {};

    let snapshot = getSnapshot() || {};
    let catalog = null;
    let catalogPromise = null;
    let settings = null;
    let activeTab = 'look';
    let openPanelKind = null;
    let railVisible = false;
    let railHideTimer = 0;
    let settingsView = null;
    let panelView = null;
    let saveChain = Promise.resolve();
    let saveDepth = 0;
    let toastTimer = 0;
    const controls = new Map();

    const layer = element('div');
    layer.id = 'vx-extras';
    layer.dataset.paused = 'false';

    const rail = element('nav', 'vxe-rail');
    rail.setAttribute('aria-label', 'Voxa quick actions');
    const railButtons = [
      ['settings', 'Open settings', ICONS.settings, false],
      ['chat', 'Open chat', ICONS.chat, false],
      ['alerts', 'Alerts', ICONS.bell, true],
      ['media', 'Now playing', ICONS.music, true],
      ['pause', 'Pause listening', ICONS.pause, false]
    ];
    for (const [kind, label, icon, dot] of railButtons) {
      const button = element('button', 'vxe-rail-btn');
      button.type = 'button';
      button.dataset.rail = kind;
      button.setAttribute('aria-label', label);
      button.title = label;
      if (kind === 'pause') {
        const pauseGlyph = element('span', 'vxe-glyph vxe-glyph-pause');
        pauseGlyph.innerHTML = ICONS.pause;
        const playGlyph = element('span', 'vxe-glyph vxe-glyph-play');
        playGlyph.innerHTML = ICONS.play;
        button.append(pauseGlyph, playGlyph);
      } else {
        const glyph = element('span', 'vxe-glyph');
        glyph.innerHTML = icon;
        button.append(glyph);
      }
      if (dot) button.append(element('i', 'vxe-dot'));
      rail.append(button);
    }

    const panel = element('section', 'vxe-panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Voxa panel');

    const toast = element('div', 'vxe-toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    layer.append(rail, panel, toast);
    document.body.append(layer);

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        if (railVisible) positionRail();
        onRectsChanged();
      })
      : null;
    if (resizeObserver) {
      resizeObserver.observe(rail);
      resizeObserver.observe(panel);
      resizeObserver.observe(root);
    }

    /* ------------------------------- state ------------------------------- */

    function syncStage() {
      const scale = Math.max(0.5, Math.min(2, numberOr(snapshot.notchScale, 100) / 100));
      document.documentElement.style.setProperty('--vxe-notch-scale', String(scale));
      const position = snapshot.notchPosition === 'left' || snapshot.notchPosition === 'right'
        ? snapshot.notchPosition
        : 'center';
      document.body.dataset.notchPosition = position;
    }

    function notifications() {
      return Array.isArray(snapshot.notifications) ? snapshot.notifications : [];
    }

    function media() {
      return snapshot.media && typeof snapshot.media === 'object' ? snapshot.media : null;
    }

    function syncRail() {
      const paused = settings?.paused === true;
      const doingPause = paused ? 'Resume listening' : 'Pause listening';
      layer.dataset.paused = paused ? 'true' : 'false';
      layer.dataset.alerts = notifications().length ? 'true' : 'false';
      layer.dataset.media = media() ? 'true' : 'false';
      const pause = rail.querySelector('[data-rail="pause"]');
      if (pause) {
        pause.setAttribute('aria-label', doingPause);
        pause.title = doingPause;
      }
      for (const button of rail.querySelectorAll('[data-rail]')) {
        const active = button.dataset.rail === openPanelKind;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    function eligibleForRail() {
      if (!snapshot.visible || openPanelKind) return false;
      const size = root.getAttribute('data-size');
      if (size === 'expanded' || size === 'chat') return false;
      return root.getAttribute('data-state') !== 'chat';
    }

    function positionRail() {
      if (!railVisible) return;
      const notchRect = root.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      if (!notchRect.width || !railRect.width) return;
      const gap = 10;
      let left = notchRect.right + gap;
      let top = notchRect.top + (notchRect.height - railRect.height) / 2;
      const fitsRight = left + railRect.width <= window.innerWidth - 10;
      const fitsLeft = notchRect.left - railRect.width - gap >= 10;
      if (!fitsRight && !fitsLeft) {
        // A medium or scaled notch leaves no room at either side. Drop the rail
        // underneath instead of painting it over the mascot and status text.
        left = notchRect.left + (notchRect.width - railRect.width) / 2;
        top = notchRect.bottom + 8;
        if (top + railRect.height > window.innerHeight - 8) {
          top = notchRect.top - railRect.height - 8;
        }
      } else if (!fitsRight) {
        left = notchRect.left - railRect.width - gap;
      }
      left = Math.max(10, Math.min(window.innerWidth - railRect.width - 10, left));
      top = Math.max(8, Math.min(window.innerHeight - railRect.height - 8, top));
      rail.style.left = `${Math.round(left)}px`;
      rail.style.top = `${Math.round(top)}px`;
    }

    function showRail() {
      if (railVisible || !eligibleForRail()) return;
      railVisible = true;
      rail.classList.add('is-on');
      positionRail();
      onRectsChanged();
    }

    function hideRail() {
      clearTimeout(railHideTimer);
      railHideTimer = 0;
      if (!railVisible) return;
      railVisible = false;
      rail.classList.remove('is-on');
      onRectsChanged();
    }

    function scheduleRailHide(delay) {
      clearTimeout(railHideTimer);
      railHideTimer = setTimeout(() => {
        railHideTimer = 0;
        if (rail.matches(':hover')) return;
        hideRail();
      }, delay);
    }

    function updateCursor(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (!eligibleForRail()) {
        hideRail();
        return;
      }
      const notchRect = root.getBoundingClientRect();
      if (!notchRect.width) {
        hideRail();
        return;
      }
      const nearNotch = pointIn(expanded(notchRect, 54), x, y);
      const onRail = railVisible && pointIn(expanded(rail.getBoundingClientRect(), 10), x, y);
      if (nearNotch || onRail) {
        showRail();
        clearTimeout(railHideTimer);
        railHideTimer = 0;
        positionRail();
      } else if (railVisible) {
        scheduleRailHide(700);
      }
    }

    /* ------------------------------- toast ------------------------------- */

    function showToast(text, tone = '') {
      clearTimeout(toastTimer);
      toast.textContent = String(text || '');
      toast.dataset.tone = tone;
      toast.classList.add('is-on');
      toastTimer = setTimeout(() => toast.classList.remove('is-on'), 2600);
    }

    /* ------------------------------ catalog ------------------------------ */

    function ensureCatalog() {
      if (catalog) return Promise.resolve(catalog);
      if (!catalogPromise) {
        catalogPromise = api.overlay.settingsCatalog()
          .then((data) => {
            catalog = data && typeof data === 'object' ? data : {};
            if (catalog.settings && typeof catalog.settings === 'object') {
              settings = { ...settings, ...catalog.settings };
            }
            syncRail();
            return catalog;
          })
          .catch((error) => {
            catalogPromise = null;
            throw error;
          });
      }
      return catalogPromise;
    }

    function register(key, sync) {
      const list = controls.get(key) || [];
      list.push(sync);
      controls.set(key, list);
    }

    function syncControls() {
      for (const list of controls.values()) {
        for (const sync of list) {
          try { sync(); } catch { /* a detached control is harmless */ }
        }
      }
    }

    function applySettingsState(next) {
      if (!next || typeof next !== 'object') return;
      settings = { ...(settings || {}), ...next };
      if (catalog) catalog.settings = settings;
      syncRail();
      syncControls();
    }

    function setSaveState(text, tone = '') {
      if (!settingsView?.saveState) return;
      settingsView.saveState.textContent = text;
      settingsView.saveState.dataset.tone = tone;
    }

    function persist(patch, options = {}) {
      saveDepth += 1;
      setSaveState('Saving…');
      const run = async () => {
        try {
          const next = await api.overlay.settingsSave(patch);
          if (next && typeof next === 'object') applySettingsState(next);
          setSaveState('Saved', 'ok');
          if (options.rerender && openPanelKind === 'settings') {
            renderTab(true);
          } else {
            syncControls();
          }
          return next;
        } catch (error) {
          setSaveState('Not saved', 'error');
          showToast(error?.message || 'Could not save that setting.', 'error');
          syncControls();
          return null;
        } finally {
          saveDepth = Math.max(0, saveDepth - 1);
        }
      };
      const task = saveChain.then(run, run);
      saveChain = task.then(() => null, () => null);
      return task;
    }

    /* --------------------------- control builders ------------------------ */

    function rowShell(label, help) {
      const row = element('div', 'vxe-row');
      const main = element('div', 'vxe-row-main');
      main.append(element('b', 'vxe-row-label', label));
      if (help) main.append(element('small', '', help));
      const side = element('div', 'vxe-row-control');
      row.append(main, side);
      return { row, side };
    }

    function selectRow(label, help, key, options, opts = {}) {
      const { row, side } = rowShell(label, help);
      const select = element('select', 'vxe-select');
      select.setAttribute('aria-label', label);
      for (const option of options) {
        const node = document.createElement('option');
        node.value = String(option.value);
        node.textContent = option.label;
        select.append(node);
      }
      select.value = String(settings?.[key] ?? options[0]?.value ?? '');
      select.addEventListener('change', () => {
        const option = options.find((item) => String(item.value) === select.value);
        void persist({ [key]: option ? option.value : select.value }, { rerender: opts.rerender });
      });
      register(key, () => {
        if (document.activeElement === select) return;
        select.value = String(settings?.[key] ?? '');
      });
      side.append(select);
      return row;
    }

    function booleanValue(key, truthyDefault) {
      const value = settings?.[key];
      return truthyDefault ? value !== false : value === true;
    }

    function switchRow(label, help, { read, write, rerender = false }) {
      const { row, side } = rowShell(label, help);
      const button = element('button', 'vxe-switch');
      button.type = 'button';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-label', label);
      const paint = () => {
        const on = Boolean(read());
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-checked', on ? 'true' : 'false');
      };
      button.addEventListener('click', () => {
        const next = !read();
        paint();
        void persist(write(next), { rerender });
      });
      paint();
      register(label, () => paint());
      side.append(button);
      return row;
    }

    function toggleRow(label, help, key, opts = {}) {
      return switchRow(label, help, {
        read: () => booleanValue(key, opts.truthyDefault),
        write: (next) => ({ [key]: next }),
        rerender: opts.rerender
      });
    }

    function rangeRow(label, help, key, min, max, step, format) {
      const { row, side } = rowShell(label, help);
      const wrap = element('div', 'vxe-range-wrap');
      const input = element('input', 'vxe-range');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(numberOr(settings?.[key], min));
      input.setAttribute('aria-label', label);
      const value = element('span', 'vxe-range-value', format(numberOr(settings?.[key], min)));
      input.addEventListener('input', () => {
        value.textContent = format(numberOr(input.value, min));
      });
      input.addEventListener('change', () => {
        void persist({ [key]: Number(input.value) });
      });
      register(key, () => {
        if (document.activeElement === input) return;
        const next = numberOr(settings?.[key], min);
        input.value = String(next);
        value.textContent = format(next);
      });
      wrap.append(input, value);
      side.append(wrap);
      return row;
    }

    function textRow(label, help, key, opts = {}) {
      const { row, side } = rowShell(label, help);
      const input = element('input', 'vxe-input');
      input.type = 'text';
      input.value = String(settings?.[key] ?? '');
      input.placeholder = opts.placeholder || '';
      input.setAttribute('aria-label', label);
      if (opts.maxLength) input.maxLength = opts.maxLength;
      input.addEventListener('change', () => {
        const value = input.value.trim();
        if (value === String(settings?.[key] ?? '')) return;
        void persist({ [key]: value }, { rerender: opts.rerender });
      });
      register(key, () => {
        if (document.activeElement === input) return;
        input.value = String(settings?.[key] ?? '');
      });
      side.append(input);
      return row;
    }

    function section(title, note) {
      const node = element('section', 'vxe-section');
      node.append(element('h3', 'vxe-section-title', title));
      if (note) node.append(element('p', 'vxe-section-note', note));
      return node;
    }

    function noteCard(text) {
      return element('p', 'vxe-inline-note', text);
    }

    /* ---------------------------- settings sheet ------------------------- */

    function panelHeader(title, subtitle) {
      const header = element('header', 'vxe-head');
      const copy = element('div', 'vxe-head-copy');
      copy.append(element('span', 'vxe-eyebrow', 'Voxa'));
      copy.append(element('h2', 'vxe-title', title));
      if (subtitle) copy.append(element('p', 'vxe-sub', subtitle));
      const close = element('button', 'vxe-icon-btn');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.title = 'Close';
      close.innerHTML = ICONS.close;
      close.addEventListener('click', () => { void closePanel(); });
      header.append(copy, close);
      return header;
    }

    function panelFooter(actions) {
      const foot = element('footer', 'vxe-foot');
      const status = element('span', 'vxe-save-state');
      status.setAttribute('aria-live', 'polite');
      const actionWrap = element('div', 'vxe-foot-actions');
      actionWrap.append(...actions);
      foot.append(status, actionWrap);
      return { foot, status };
    }

    function actionButton(label, className, handler) {
      const button = element('button', `vxe-btn${className ? ` ${className}` : ''}`, label);
      button.type = 'button';
      button.addEventListener('click', handler);
      return button;
    }

    function renderSettingsPanel() {
      panel.dataset.kind = 'settings';
      panel.setAttribute('aria-label', 'Voxa notch settings');
      const header = panelHeader('Notch settings', 'Every change saves and applies immediately.');
      const tabs = element('div', 'vxe-tabs');
      tabs.setAttribute('role', 'tablist');
      const tabButtons = new Map();
      for (const [id, label] of TABS) {
        const button = element('button', 'vxe-tab', label);
        button.type = 'button';
        button.dataset.tab = id;
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => {
          if (activeTab === id) return;
          activeTab = id;
          for (const [tabId, node] of tabButtons) {
            const on = tabId === activeTab;
            node.classList.toggle('is-active', on);
            node.setAttribute('aria-selected', on ? 'true' : 'false');
          }
          renderTab();
        });
        tabButtons.set(id, button);
        tabs.append(button);
      }
      const body = element('div', 'vxe-body');
      body.setAttribute('role', 'tabpanel');
      const done = actionButton('Done', 'primary', () => { void closePanel(); });
      const dashboard = actionButton('Open dashboard', 'ghost', () => {
        api.overlay.openSettings();
        void closePanel();
      });
      dashboard.prepend(Object.assign(document.createElement('span'), { innerHTML: ICONS.dashboard }));
      const { foot, status } = panelFooter([dashboard, done]);
      settingsView = { body, tabs: tabButtons, saveState: status };
      panel.replaceChildren(header, tabs, body, foot);
      for (const [id, node] of tabButtons) {
        const on = id === activeTab;
        node.classList.toggle('is-active', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      renderTab();
    }

    function renderTab(keepScroll = false) {
      if (!settingsView) return;
      const body = settingsView.body;
      const top = keepScroll ? body.scrollTop : 0;
      controls.clear();
      body.replaceChildren();
      if (!catalog || !settings) {
        const loading = element('div', 'vxe-empty');
        loading.append(element('b', '', catalog ? 'Loading settings…' : 'Reading settings…'));
        loading.append(element('small', '', 'The notch sheet reads the same store as the dashboard.'));
        body.append(loading);
        void ensureCatalog().then(() => {
          if (openPanelKind === 'settings' && settingsView) renderTab();
        }).catch((error) => {
          loading.replaceChildren();
          loading.append(element('b', '', 'Settings could not load.'));
          loading.append(element('small', '', error?.message || 'Try again from the dashboard.'));
        });
        return;
      }
      switch (activeTab) {
        case 'voice': renderVoiceTab(body); break;
        case 'assistant': renderAssistantTab(body); break;
        case 'system': renderSystemTab(body); break;
        case 'look':
        default: renderLookTab(body); break;
      }
      body.scrollTop = top;
      setSaveState('All changes saved');
    }

    function renderLookTab(body) {
      const overlay = section('Overlay', 'The notch keeps its shape; these controls tune how it enters the stage.');
      overlay.append(
        selectRow('Overlay style', 'Island floats below the work area; Notch stays attached to the top edge.', 'overlayStyle', [
          { value: 'island', label: 'Island' },
          { value: 'notch', label: 'Notch' }
        ]),
        toggleRow('Animated companion', 'Let the character react to listening, thinking, replies, and errors.', 'companionEnabled', { truthyDefault: true }),
        toggleRow('Follow the cursor', 'Track the pointer with the companion\'s eyes.', 'companionFollow', { truthyDefault: true }),
        selectRow('Companion', 'Which character sits in the notch.', 'notchCast', [
          { value: 'bob', label: 'Bob' },
          { value: 'girl', label: 'Girl' },
          { value: 'boy', label: 'Boy' },
          { value: 'couple', label: 'Couple' }
        ], { rerender: true }),
        selectRow('Palette', 'Auto picks the palette that matches the companion.', 'notchPalette', [
          { value: 'auto', label: 'Auto' },
          { value: 'wine', label: 'Wine' },
          { value: 'ember', label: 'Ember' },
          { value: 'mint', label: 'Mint' },
          { value: 'sky', label: 'Sky' },
          { value: 'plum', label: 'Plum' },
          { value: 'brick', label: 'Brick' },
          { value: 'boy', label: 'Boy' }
        ])
      );

      const stage = section('Stage', 'Resting size only changes the idle pill; answers and approvals stay wide enough for their controls.');
      stage.append(
        selectRow('Resting size', 'Auto keeps the kit\'s compact idle pill.', 'notchSize', [
          { value: 'auto', label: 'Auto' },
          { value: 'compact', label: 'Compact' },
          { value: 'medium', label: 'Medium' },
          { value: 'expanded', label: 'Expanded' }
        ]),
        rangeRow('Scale', 'Grow or shrink the notch and mascot together.', 'notchScale', 80, 120, 5, (value) => `${value}%`),
        selectRow('Screen position', 'Which edge of the current display the notch hugs.', 'notchPosition', [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' }
        ]),
        rangeRow('Top offset', 'Nudge the whole notch down from the top edge.', 'notchOffsetY', 0, 64, 2, (value) => `${value}px`),
        selectRow('When idle', 'Auto hide after a reply, or keep a resting notch on screen.', 'notchBehavior', [
          { value: 'auto', label: 'Auto hide' },
          { value: 'stay-open', label: 'Stay open' }
        ])
      );

      const timers = section('Timers', 'The same dwells the dashboard uses for toasts, the alert feed, and media snooze.');
      timers.append(
        selectRow('Alert toast', 'How long an unread-event toast stays up.', 'feedToastSeconds', [2, 4, 6, 8, 12].map((n) => ({ value: n, label: `${n} s` }))),
        selectRow('Alert feed', 'How long the open alert feed stays up.', 'feedDwellSeconds', [4, 8, 12, 20, 30].map((n) => ({ value: n, label: `${n} s` }))),
        selectRow('Media snooze', 'How long a stop press keeps the now-playing pill away.', 'mediaSnoozeMinutes', [1, 3, 5, 10, 15].map((n) => ({ value: n, label: `${n} min` })))
      );

      body.append(overlay, stage, timers);
    }

    function voiceSelectOptions() {
      const list = Array.isArray(catalog?.voices) ? catalog.voices : [];
      const labels = catalog?.languages && typeof catalog.languages === 'object' ? catalog.languages : {};
      const groups = new Map();
      for (const voice of list) {
        if (!voice || !voice.id) continue;
        const lang = String(voice.lang || 'a');
        if (!groups.has(lang)) groups.set(lang, []);
        groups.get(lang).push(voice);
      }
      return { list, labels, groups };
    }

    function voicePicker(selected, disabled) {
      const { list, labels, groups } = voiceSelectOptions();
      const select = element('select', 'vxe-select');
      select.setAttribute('aria-label', 'Voice');
      select.disabled = disabled;
      for (const [lang, voices] of groups) {
        const group = document.createElement('optgroup');
        group.label = labels[lang] || lang;
        for (const voice of voices) {
          const option = document.createElement('option');
          option.value = voice.id;
          option.textContent = voice.label || voice.id;
          group.append(option);
        }
        select.append(group);
      }
      if (!list.some((voice) => voice.id === selected)) {
        const group = document.createElement('optgroup');
        group.label = 'Current';
        const option = document.createElement('option');
        option.value = selected;
        option.textContent = `${selected} (${NOT_AVAILABLE})`;
        group.append(option);
        select.append(group);
      }
      select.value = selected;
      select.addEventListener('change', () => {
        void persist({ ttsVoice: select.value }, { rerender: true });
      });
      return select;
    }

    function renderVoiceTab(body) {
      const engine = ['kokoro', 'omnivoice'].includes(settings.ttsEngine) ? settings.ttsEngine : 'windows';
      const replies = section('Spoken replies', 'Reply audio uses the same engine as the dashboard.');
      replies.append(toggleRow('Spoken replies', 'Read answers and confirmations aloud.', 'spokenReplies', { truthyDefault: true }));

      const voiceSection = section('Voice', 'Kokoro provides the natural voices; OmniVoice and its voice modes are configured in the dashboard; Windows is always available.');
      const engineRow = rowShell('Engine', 'Choose the voice pipeline used for replies.');
      const engineSelect = element('select', 'vxe-select');
      engineSelect.setAttribute('aria-label', 'Engine');
      for (const option of [
        { value: 'windows', label: 'Windows (built-in)' },
        { value: 'kokoro', label: 'Kokoro · natural voice' },
        { value: 'omnivoice', label: 'OmniVoice (local)' }
      ]) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        engineSelect.append(node);
      }
      engineSelect.value = engine;
      engineSelect.addEventListener('change', () => {
        void persist({ ttsEngine: engineSelect.value }, { rerender: true });
      });
      register('ttsEngine', () => {
        if (document.activeElement !== engineSelect) {
          engineSelect.value = ['kokoro', 'omnivoice'].includes(settings.ttsEngine) ? settings.ttsEngine : 'windows';
        }
      });
      engineRow.side.append(engineSelect);
      voiceSection.append(engineRow.row);

      const voiceRow = rowShell('Voice', 'Voices are grouped by language. Kokoro downloads them on demand from the dashboard.');
      const picker = voicePicker(String(settings.ttsVoice || 'af_heart'), engine !== 'kokoro');
      voiceRow.side.append(picker);
      register('ttsVoice', () => {
        if (document.activeElement === picker) return;
        picker.value = String(settings.ttsVoice || 'af_heart');
        picker.disabled = settings.ttsEngine !== 'kokoro';
      });
      voiceSection.append(voiceRow.row);
      voiceSection.append(
        rangeRow('Speed', 'Speaking rate for synthesized replies.', 'ttsSpeed', 0.7, 1.4, 0.05, (value) => `${Number(value).toFixed(2)}×`),
        rangeRow('Volume', 'Playback level for reply audio.', 'ttsVolume', 0, 1, 0.05, (value) => `${Math.round(value * 100)}%`)
      );

      const advanced = section('Voice engine', 'These switches mirror the dashboard voice settings.');
      advanced.append(
        toggleRow('Use GPU for Kokoro', 'Load the model on CUDA when available; otherwise it falls back to CPU.', 'ttsGpu'),
        toggleRow('Automatic voice fallback', 'Use Heart when the selected voice is unavailable.', 'ttsAutoVoice', { truthyDefault: true }),
        toggleRow('Battery saver', 'Use the built-in Windows voice while on battery.', 'ttsBatterySaver', { truthyDefault: true })
      );
      body.append(replies, voiceSection, advanced, noteCard('Kokoro model downloads, preview, and voice-pack management live in Dashboard → Dictation.'));
    }

    function renderAssistantTab(body) {
      const modes = section('Mode', 'Dictation types into the focused field; Agent can run approved desktop actions.');
      modes.append(
        selectRow('Active mode', 'The shortcut target for the next request.', 'mode', [
          { value: 'agent', label: 'Agent' },
          { value: 'dictation', label: 'Dictation' }
        ]),
        toggleRow('Enable dictation', 'Hold the dictation shortcut to record and type.', 'dictationEnabled', { truthyDefault: true }),
        toggleRow('Enable agent', 'Hold the agent shortcut to ask for help.', 'agentEnabled', { truthyDefault: true }),
        toggleRow('Save turn history', 'Keep dictation, agent, and chat turns in history and logs.', 'historyEnabled', { truthyDefault: true })
      );

      const permission = section('Permissions', 'Routine actions can run without a prompt; sensitive actions always ask.');
      permission.append(
        selectRow('Permission mode', 'How Agent Mode handles desktop actions.', 'permissionMode', [
          { value: 'ask', label: 'Ask Every Time' },
          { value: 'routine', label: 'Allow Routine Actions' },
          { value: 'custom', label: 'Custom' }
        ], { rerender: true }),
        toggleRow('Full access', 'Agent runs every action without asking. Tool schema, folder limits, and HTTPS checks still apply.', 'agentFullAccess')
      );
      if (settings.permissionMode === 'custom') {
        const categories = Array.isArray(catalog?.permissionCategories) ? catalog.permissionCategories : [];
        for (const category of categories) {
          if (!category || !category.id) continue;
          permission.append(switchRow(category.label || category.id, category.detail || '', {
            read: () => settings.permissionCustom?.[category.id] === true,
            write: (next) => ({ permissionCustom: { [category.id]: next } })
          }));
        }
      }
      permission.append(noteCard('Full access and Custom only affect routine actions; typing, send, and other sensitive actions always ask.'));
      body.append(modes, permission);
    }

    function renderSystemTab(body) {
      const listening = section('Listening', 'Pause without quitting; the notch stays asleep until you resume.');
      listening.append(
        toggleRow('Pause listening', 'Ignore dictation and agent shortcuts.', 'paused'),
        toggleRow('Start with Windows', 'Keep Voxa ready in the tray after sign-in.', 'startWithWindows'),
        toggleRow('Automatically check for updates', 'Check GitHub Releases after launch and every six hours.', 'autoCheckUpdates', { truthyDefault: true })
      );

      const shortcuts = section('Shortcuts', 'Use forms like Ctrl+Q or Alt+Q. Changes apply immediately when valid.');
      shortcuts.append(
        textRow('Dictation shortcut', 'Hold to record, release to send.', 'dictationHotkey', { placeholder: 'Ctrl+Q' }),
        textRow('Agent shortcut', 'Hold to ask, release to send.', 'agentHotkey', { placeholder: 'Alt+Q' })
      );

      const profile = section('Profile', 'These values are shared with the dashboard profile.');
      profile.append(
        textRow('Display name', 'Shown in the dashboard and tray.', 'displayName', { maxLength: 50 }),
        textRow('Community URL', 'Optional HTTPS link.', 'communityUrl', { placeholder: 'https://…' })
      );

      body.append(listening, shortcuts, profile, noteCard('Microphone, Whisper model, provider keys, and Kokoro downloads stay in the dashboard, where their progress is visible.'));
    }

    /* ------------------------------ alerts ------------------------------- */

    function renderAlertsPanel() {
      panel.dataset.kind = 'alerts';
      panel.setAttribute('aria-label', 'Voxa alerts');
      const items = notifications();
      const header = panelHeader('Alerts', items.length ? `${items.length} waiting` : 'Nothing waiting');
      const body = element('div', 'vxe-body');
      if (!items.length) {
        body.append(emptyState(ICONS.alert, 'No alerts right now.', 'Downloads, finished turns, media sessions, and system events will show up here.'));
      } else {
        const list = element('div', 'vxe-alert-list');
        for (const item of items) {
          const card = element('div', 'vxe-alert');
          card.dataset.kind = item.kind || 'system';
          card.append(element('span', 'vxe-alert-dot'));
          const main = element('div', 'vxe-alert-main');
          main.append(element('b', 'vxe-alert-title', item.title || 'Alert'));
          if (item.body) main.append(element('p', 'vxe-alert-body', item.body));
          main.append(element('span', 'vxe-alert-meta', `${kindLabel(item.kind)} · ${timeLabel(item.ts)}`));
          const close = element('button', 'vxe-icon-btn vxe-alert-close');
          close.type = 'button';
          close.setAttribute('aria-label', `Dismiss ${item.title || 'alert'}`);
          close.title = 'Dismiss';
          close.innerHTML = ICONS.close;
          close.addEventListener('click', () => {
            try { api.overlay.dismissNotification(item.id); } catch { /* the list is already gone */ }
          });
          card.append(main, close);
          list.append(card);
        }
        body.append(list);
      }
      const clear = actionButton('Clear all', '', () => {
        try { api.overlay.feedClear(); } catch { /* older bridge */ }
        showToast('Alerts cleared');
      });
      clear.disabled = items.length === 0;
      const done = actionButton('Close', 'primary', () => { void closePanel(); });
      const { foot } = panelFooter([clear, done]);
      panel.replaceChildren(header, body, foot);
      requestAnimationFrame(onRectsChanged);
    }

    function emptyState(icon, title, detail) {
      const empty = element('div', 'vxe-empty');
      const art = element('div', 'vxe-empty-art');
      art.innerHTML = icon;
      empty.append(art, element('b', '', title), element('small', '', detail));
      return empty;
    }

    /* ------------------------------- media ------------------------------- */

    function renderMediaPanel() {
      panel.dataset.kind = 'media';
      panel.setAttribute('aria-label', 'Voxa now playing');
      const now = media();
      const header = panelHeader('Now playing', now?.app || 'Windows media session');
      const body = element('div', 'vxe-body');
      if (!now) {
        body.append(emptyState(ICONS.music, 'No media session.', 'Start playback in any app and Windows will hand the session to the notch.'));
      } else {
        const hero = element('div', 'vxe-media-hero');
        const art = element('div', 'vxe-art');
        art.innerHTML = ICONS.music;
        const copy = element('div', 'vxe-media-copy');
        copy.append(element('div', 'vxe-media-title', now.title || 'Unknown title'));
        if (now.artist) copy.append(element('div', 'vxe-media-artist', now.artist));
        const chip = element('span', 'vxe-chip', now.playing ? 'Playing' : 'Paused');
        chip.dataset.state = now.playing ? 'playing' : 'paused';
        copy.append(chip);
        hero.append(art, copy);

        const transport = element('div', 'vxe-transport');
        const prev = transportButton(ICONS.previous, 'Previous track', !now.canPrev, () => sendMedia('previous'));
        const toggle = transportButton(now.playing ? ICONS.pause : ICONS.play, now.playing ? 'Pause' : 'Play', !now.canToggle, () => sendMedia('toggle'));
        toggle.classList.add('vxe-round-primary');
        const next = transportButton(ICONS.next, 'Next track', !now.canNext, () => sendMedia('next'));
        transport.append(prev, toggle, next);
        body.append(hero, transport, noteCard('Transport controls talk to the same Windows session as the dashboard.'));
      }
      const close = actionButton('Close', 'primary', () => { void closePanel(); });
      const { foot } = panelFooter([close]);
      panel.replaceChildren(header, body, foot);
      requestAnimationFrame(onRectsChanged);
    }

    function transportButton(icon, label, disabled, handler) {
      const button = element('button', 'vxe-round');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.disabled = Boolean(disabled);
      button.innerHTML = icon;
      if (!disabled) button.addEventListener('click', handler);
      return button;
    }

    function sendMedia(action) {
      try { api.overlay.mediaControl(action); } catch { /* no session */ }
    }

    /* ----------------------------- panel flow ---------------------------- */

    function renderPanel(kind) {
      if (kind === 'settings') renderSettingsPanel();
      else if (kind === 'alerts') renderAlertsPanel();
      else if (kind === 'media') renderMediaPanel();
    }

    function openPanelFromState(kind) {
      const next = PANEL_KINDS.includes(kind) ? kind : null;
      if (!next) {
        closePanelFromState();
        return;
      }
      const fresh = openPanelKind !== next || panel.hidden;
      openPanelKind = next;
      document.body.dataset.panel = next;
      layer.dataset.panel = next;
      panel.hidden = false;
      hideRail();
      if (fresh) {
        if (next === 'settings' && (!catalog || !settings)) {
          panel.replaceChildren(panelHeader('Notch settings', 'Reading the shared settings store…'), element('div', 'vxe-body'));
          void ensureCatalog().then(() => {
            if (openPanelKind === 'settings') renderPanel('settings');
          }).catch((error) => {
            if (openPanelKind === 'settings') showToast(error?.message || 'Settings could not load.', 'error');
          });
        } else {
          renderPanel(next);
        }
      }
      syncRail();
      requestAnimationFrame(onRectsChanged);
    }

    function closePanelFromState() {
      if (!openPanelKind && panel.hidden) return;
      openPanelKind = null;
      hideRail();
      panel.hidden = true;
      panel.replaceChildren();
      settingsView = null;
      delete document.body.dataset.panel;
      delete layer.dataset.panel;
      syncRail();
      requestAnimationFrame(onRectsChanged);
    }

    async function openPanel(kind) {
      if (!PANEL_KINDS.includes(kind)) return;
      if (openPanelKind === kind) {
        await closePanel();
        return;
      }
      hideRail();
      try {
        if (kind === 'settings' && (!catalog || !settings)) await ensureCatalog();
        const result = await api.overlay.setPanel(kind);
        if (result?.panel === kind) openPanelFromState(kind);
      } catch (error) {
        showToast(error?.message || 'That panel could not open.', 'error');
      }
    }

    async function closePanel() {
      try {
        await api.overlay.setPanel(null);
      } catch {
        // The window may already be folding; hide the painted panel anyway.
      }
      closePanelFromState();
    }

    /* ------------------------------- wire -------------------------------- */

    rail.addEventListener('click', (event) => {
      const button = event.target.closest('[data-rail]');
      if (!button) return;
      const kind = button.dataset.rail;
      if (kind === 'pause') {
        try { api.overlay.pauseToggle(); } catch { /* bridge guard */ }
        return;
      }
      if (kind === 'chat') {
        api.chat.open();
        hideRail();
        return;
      }
      void openPanel(kind);
    });
    rail.addEventListener('pointerenter', () => {
      clearTimeout(railHideTimer);
      railHideTimer = 0;
    });
    rail.addEventListener('pointerleave', () => scheduleRailHide(650));

    panel.addEventListener('pointerdown', (event) => {
      // Clicking the sheet must never leak through to the stage behind it.
      if (!event.target.closest('button, input, select, textarea, label')) event.stopPropagation();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !openPanelKind) return;
      event.preventDefault();
      event.stopPropagation();
      void closePanel();
    }, true);

    api.on('settings:updated', (next) => {
      if (!next || typeof next !== 'object') return;
      const previousMode = settings?.permissionMode;
      settings = { ...(settings || {}), ...next };
      if (catalog) catalog.settings = settings;
      syncRail();
      if (openPanelKind !== 'settings' || !settingsView) return;
      if (saveDepth > 0) {
        syncControls();
        return;
      }
      const active = document.activeElement;
      const typing = active && active !== document.body && panel.contains(active)
        && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
      if (typing && settings.permissionMode === previousMode) {
        syncControls();
      } else {
        renderTab(true);
      }
    });

    void ensureCatalog().catch(() => {
      // The sheet retries when it is opened; the rail still works without it.
    });

    /* ------------------------------- reset ------------------------------- */

    function update(next) {
      snapshot = next && typeof next === 'object' ? next : {};
      syncStage();
      syncRail();
      const nextPanel = PANEL_KINDS.includes(snapshot.panel) ? snapshot.panel : null;
      if (!snapshot.visible) {
        hideRail();
        closePanelFromState();
        return;
      }
      if (nextPanel) {
        openPanelFromState(nextPanel);
        if (nextPanel === 'alerts') renderAlertsPanel();
        else if (nextPanel === 'media') renderMediaPanel();
      } else {
        closePanelFromState();
        if (railVisible) positionRail();
      }
    }

    function getHitRects() {
      const rects = [];
      if (openPanelKind && !panel.hidden) {
        const rect = panel.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) rects.push(rectPayload(rect));
        return rects;
      }
      if (railVisible) {
        const rect = rail.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) rects.push(rectPayload(rect));
      }
      return rects;
    }

    function interactiveRects() {
      return getHitRects();
    }

    function destroy() {
      clearTimeout(railHideTimer);
      clearTimeout(toastTimer);
      resizeObserver?.disconnect();
      layer.remove();
    }

    syncStage();
    syncRail();

    return {
      update,
      updateCursor,
      getHitRects,
      interactiveRects,
      openPanel,
      openSettings: () => openPanel('settings'),
      isPanelOpen: () => Boolean(openPanelKind),
      closePanel,
      destroy
    };
  }

  global.VoxaOverlayExtras = { mount };
})(window);
