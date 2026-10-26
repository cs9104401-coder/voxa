'use strict';

/*
 * Voxa overlay glue.
 *
 * The visual kit (CSS, VoxaMascot, VoxaNotch) is copied verbatim from the
 * locked drop-in. This file owns only the bridge between the real overlay
 * snapshot / IPC channels and the kit API.
 */

const api = window.voiceAgent;
const root = document.querySelector('#notch');
const kit = window.VoxaNotch;

if (!api || !root || !kit) {
  throw new Error('Voxa overlay could not start: preload bridge or notch kit is missing.');
}

const BAND_COUNT = 16;
const CHAT_PREVIEW_MESSAGES = [
  { role: 'user', content: 'Give me a quick summary of my day.' },
  { role: 'assistant', content: 'You have three tasks left. The next one is a 2 pm review, then two short follow-ups.' }
];

let snapshot = {
  visible: false,
  status: 'idle',
  mode: 'agent',
  message: '',
  approval: null,
  canCopy: false,
  streaming: false,
  speaking: false,
  companionEnabled: true,
  style: 'island',
  slowMotion: false,
  dismiss: null,
  expand: 'auto',
  stageMax: 0,
  chatOpen: false,
  chatStreaming: false,
  chatPreview: false,
  notifications: [],
  feedPreview: false,
  download: null,
  media: null
};

const chatView = {
  open: false,
  requestId: 0,
  messages: [],
  streaming: false,
  lastDelta: ''
};

let renderedSignature = '';
let lastAppliedStyle = '';
let lastAppliedCompanion = null;
let lastHit = null;
let lastHitKey = '';
let hoverInside = false;
let hideAckTimer = 0;
let lastPillKey = '';
let lastNotificationId = '';
let restoredChatAfterStop = false;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/* --- Safe markdown used by answers and assistant chat bubbles ------------- */
function inline(parent, text) {
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(text))) {
    parent.append(document.createTextNode(text.slice(index, match.index)));
    const element = document.createElement(match[1] ? 'strong' : match[2] ? 'em' : 'code');
    element.textContent = match[1] || match[2] || match[3];
    parent.append(element);
    index = pattern.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(index)));
}

function markdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || '').split(/\r?\n/);
  const paragraph = [];
  let index = 0;
  function flush() {
    if (!paragraph.length) return;
    const element = document.createElement('p');
    inline(element, paragraph.join(' '));
    fragment.append(element);
    paragraph.length = 0;
  }
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush();
      index += 1;
      const block = [];
      while (index < lines.length && !/^\s*```/.test(lines[index])) block.push(lines[index++]);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.join('\n');
      pre.append(code);
      fragment.append(pre);
      index += 1;
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)/);
    if (heading) {
      flush();
      const element = document.createElement(`h${Math.min(4, heading[1].length + 1)}`);
      inline(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length && (/^\s*[-*+]\s+/.test(lines[index]) || /^\s*\d+[.)]\s+/.test(lines[index]))) {
        const item = document.createElement('li');
        inline(item, lines[index].replace(/^\s*(?:[-*+] |\d+[.)] )/, ''));
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return fragment;
}

function renderMarkdown(element, text) {
  element.replaceChildren(markdown(text));
}

/* --- Kit mount ------------------------------------------------------------ */
function sendHitRect(rect) {
  if (!rect || !snapshot.visible) return;
  const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
  if (key === lastHitKey) return;
  lastHitKey = key;
  try {
    api.overlay.hitRect(rect);
  } catch {
    // A closing window can reject one shape update; the next repaint reports again.
  }
}

const notch = kit.mount(root, {
  fixed: true,
  style: snapshot.style === 'notch' ? 'notch' : 'island',
  onHitRect(rect) {
    lastHit = rect;
    sendHitRect(rect);
  },
  renderText: renderMarkdown
});

function resendHitRect() {
  const rect = notch.getHitRect();
  if (rect) {
    lastHit = rect;
    sendHitRect(rect);
  }
}

/* --- Snapshot to kit state ------------------------------------------------ */
function compactWhenCollapsed(options) {
  if (snapshot.expand === 'collapsed') options.size = 'compact';
  return options;
}

function feedText(items) {
  if (!Array.isArray(items) || !items.length) return 'No alerts right now.';
  return items.slice(0, 4).map((item) => {
    const title = String(item.title || 'Alert');
    const body = String(item.body || '').trim();
    return body ? `**${title}**\n${body}` : `**${title}**`;
  }).join('\n\n');
}

function viewFor(snap) {
  const mode = snap.mode === 'dictation' ? 'dictation' : 'agent';
  const message = String(snap.message || '');
  switch (snap.status) {
    case 'listening':
      return {
        state: 'listening',
        options: compactWhenCollapsed({ text: message || 'Speak naturally. Release to send.', mode })
      };
    case 'thinking':
      return {
        state: 'thinking',
        options: compactWhenCollapsed({ text: message || 'Thinking…', mode })
      };
    case 'executing':
      return {
        state: 'executing',
        options: compactWhenCollapsed({ text: message || 'Working…', mode })
      };
    case 'verifying':
      return {
        state: 'verifying',
        options: compactWhenCollapsed({ text: message || 'Checking the result…', mode })
      };
    case 'approval':
      return {
        state: 'approval',
        options: {
          title: snap.approval?.title || 'Approval needed',
          text: snap.approval?.detail || message || 'Allow this action?',
          mode
        }
      };
    case 'answer':
      return { state: 'answer', options: compactWhenCollapsed({ text: message, mode, spoken: Boolean(snap.speaking) }) };
    case 'error':
      return { state: 'error', options: compactWhenCollapsed({ text: message || 'Something went wrong.', mode }) };
    case 'done':
      return { state: 'happy', options: compactWhenCollapsed({ text: message || 'Done.', mode }) };
    case 'chat':
      return { state: 'chat', options: { title: 'Chat', mode } };
    case 'feed': {
      const items = Array.isArray(snap.notifications) ? snap.notifications : [];
      return {
        state: 'idle',
        options: compactWhenCollapsed({
          title: items.length ? `Alerts · ${items.length}` : 'Alerts',
          text: feedText(items),
          mode,
          size: 'expanded'
        })
      };
    }
    case 'media': {
      const media = snap.media && typeof snap.media === 'object' ? snap.media : null;
      const title = media?.title ? String(media.title) : 'Now playing';
      const artist = media?.artist ? String(media.artist) : '';
      return {
        state: 'idle',
        options: compactWhenCollapsed({
          title: 'Now playing',
          text: artist ? `${title} — ${artist}` : title,
          mode,
          size: 'medium'
        })
      };
    }
    case 'idle':
    default:
      return {
        state: 'idle',
        options: compactWhenCollapsed({
          text: snap.expand === 'pinned' ? 'Ready.' : '',
          mode,
          size: snap.expand === 'pinned' ? 'expanded' : 'compact'
        })
      };
  }
}

function applySettings(snap) {
  const style = snap.style === 'notch' ? 'notch' : 'island';
  if (style !== lastAppliedStyle) {
    lastAppliedStyle = style;
    notch.setStyle(style);
  }
  const companion = snap.companionEnabled !== false;
  if (companion !== lastAppliedCompanion) {
    lastAppliedCompanion = companion;
    notch.setCompanion(companion);
  }
}

function renderSurface() {
  if (!snapshot.visible) {
    renderedSignature = '';
    lastHitKey = '';
    notch.fold();
    notch.pillClear();
    lastPillKey = '';
    return;
  }
  applySettings(snapshot);
  const view = viewFor(snapshot);
  const signature = JSON.stringify({
    state: view.state,
    options: view.options,
    expand: snapshot.expand
  });
  if (signature !== renderedSignature || root.dataset.state !== view.state) {
    renderedSignature = signature;
    notch.show(view.state, view.options);
    requestAnimationFrame(resendHitRect);
  }
  updateActivityPill();
  syncChatState();
}

/* --- Activity pill -------------------------------------------------------- */
function updateActivityPill() {
  if (!snapshot.visible) return;
  const download = snapshot.download;
  if (download) {
    const percent = download.percent == null ? null : Number(download.percent);
    const suffix = percent == null
      ? (download.phase === 'loading' ? ' · loading' : '')
      : ` · ${Math.round(percent)}%`;
    const key = `download|${download.phase}|${download.label}|${percent}`;
    if (key !== lastPillKey) {
      lastPillKey = key;
      // Whisper swaps and Kokoro packs have a real cancel path. Ollama pulls
      // do not, so the kit must not offer a button that cannot do anything.
      const cancelable = /^(?:Whisper|Voice)\b/.test(String(download.label || ''));
      notch.pill(`${download.label}${suffix}`, {
        progress: percent == null ? undefined : clamp(percent / 100, 0, 1),
        cancel: cancelable
      });
    }
    return;
  }
  if (lastPillKey.startsWith('download|')) {
    lastPillKey = '';
    notch.pillClear();
  }
  const newest = Array.isArray(snapshot.notifications) ? snapshot.notifications[0] : null;
  if (!newest || !newest.id) return;
  if (String(newest.id) === lastNotificationId) return;
  lastNotificationId = String(newest.id);
  lastPillKey = `feed|${lastNotificationId}`;
  notch.pill(String(newest.title || 'Voxa'), { ms: 5000 });
}

/* --- Chat ---------------------------------------------------------------- */
function chatText(message) {
  let text = String(message?.content || '');
  if (message?.cancelled) text += `${text ? '\n\n' : ''}_Stopped._`;
  if (message?.error) text += `${text ? '\n\n' : ''}_${message.error}_`;
  return text;
}

function rebuildChatLog() {
  notch.chat.clear();
  for (const message of chatView.messages) {
    notch.chat.add(message.role === 'user' ? 'user' : 'assistant', chatText(message));
  }
  notch.chat.setStreaming(chatView.streaming);
}

function loadChatPreview() {
  chatView.messages = CHAT_PREVIEW_MESSAGES.map((message) => ({ ...message }));
  chatView.streaming = false;
  chatView.lastDelta = '';
  rebuildChatLog();
}

function syncChatState() {
  const open = snapshot.status === 'chat' && snapshot.chatOpen && snapshot.visible;
  const streaming = open && Boolean(snapshot.chatStreaming);
  if (open && !chatView.open) {
    chatView.open = true;
    chatView.requestId = 0;
    chatView.messages = [];
    chatView.streaming = streaming;
    chatView.lastDelta = '';
    notch.chat.clear();
    notch.chat.setStreaming(streaming);
    if (snapshot.chatPreview) loadChatPreview();
    else {
      try {
        api.chat.requestHistory();
      } catch {
        // The preload guard is the only failure mode here.
      }
    }
  } else if (!open && chatView.open) {
    chatView.open = false;
    chatView.streaming = false;
    chatView.lastDelta = '';
    notch.chat.setStreaming(false);
  }
  if (open && chatView.streaming !== streaming) {
    chatView.streaming = streaming;
    notch.chat.setStreaming(streaming);
  }
}

function restoreChatAfterStop() {
  if (restoredChatAfterStop) return;
  restoredChatAfterStop = true;
  setTimeout(() => {
    restoredChatAfterStop = false;
    if (!snapshot.visible || !chatView.open) return;
    renderedSignature = '';
    renderSurface();
  }, 0);
}

function applyChatStarted(payload) {
  const id = Number(payload?.id) || 0;
  if (id) chatView.requestId = id;
  chatView.streaming = true;
  const last = chatView.messages[chatView.messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.streaming) {
    chatView.messages.push({ role: 'assistant', content: '', streaming: true });
    if (chatView.open) notch.chat.add('assistant', '');
  }
  if (chatView.open) notch.chat.setStreaming(true);
}

function applyChatDelta(payload) {
  if (!payload) return;
  const id = Number(payload.id) || 0;
  if (id && chatView.requestId && id !== chatView.requestId) return;
  const text = String(payload.text || '');
  let last = chatView.messages[chatView.messages.length - 1];
  if (!last || last.role !== 'assistant') {
    last = { role: 'assistant', content: '', streaming: true };
    chatView.messages.push(last);
    if (chatView.open) notch.chat.add('assistant', '');
  }
  last.content = text;
  last.streaming = true;
  chatView.streaming = true;
  if (chatView.open) {
    if (!chatView.lastDelta) {
      if (text) notch.chat.append(text);
    } else if (text.startsWith(chatView.lastDelta)) {
      const suffix = text.slice(chatView.lastDelta.length);
      if (suffix) notch.chat.append(suffix);
    } else {
      rebuildChatLog();
    }
    notch.chat.setStreaming(true);
  }
  chatView.lastDelta = text;
}

function applyChatDone(payload) {
  if (!payload) return;
  const id = Number(payload.id) || 0;
  if (id && chatView.requestId && id !== chatView.requestId) return;
  const text = String(payload.text || '');
  const last = chatView.messages[chatView.messages.length - 1];
  if (last && last.role === 'assistant') {
    last.content = text;
    last.streaming = false;
    last.cancelled = Boolean(payload.cancelled);
    last.error = '';
  } else {
    chatView.messages.push({
      role: 'assistant',
      content: text,
      streaming: false,
      cancelled: Boolean(payload.cancelled),
      error: ''
    });
  }
  chatView.streaming = false;
  if (chatView.open) {
    if (payload.cancelled) {
      rebuildChatLog();
    } else if (text.startsWith(chatView.lastDelta)) {
      const suffix = text.slice(chatView.lastDelta.length);
      if (suffix) notch.chat.append(suffix);
    } else {
      rebuildChatLog();
    }
    notch.chat.setStreaming(false);
  }
  chatView.lastDelta = text;
  if (payload.cancelled) notch.pill('Reply stopped', { ms: 2400 });
}

function applyChatError(payload) {
  if (!payload) return;
  const id = Number(payload.id) || 0;
  if (id && chatView.requestId && id !== chatView.requestId) return;
  const message = String(payload.message || 'The reply failed.');
  chatView.streaming = false;
  chatView.lastDelta = '';
  if (chatView.open) notch.chat.setStreaming(false);
  notch.pill(message, { ms: 5000 });
  if (chatView.open) {
    try {
      api.chat.requestHistory();
    } catch {
      // The preload guard is the only failure mode here.
    }
  }
}

function applyChatHistory(payload) {
  if (!payload || !Array.isArray(payload.messages)) return;
  chatView.messages = payload.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: String(message.content || ''),
      streaming: Boolean(message.streaming),
      cancelled: Boolean(message.cancelled),
      error: message.error ? String(message.error) : ''
    }));
  chatView.streaming = Boolean(payload.streaming);
  chatView.requestId = Number(payload.requestId) || chatView.requestId;
  if (snapshot.chatPreview) return;
  const last = chatView.messages[chatView.messages.length - 1];
  chatView.lastDelta = last?.role === 'assistant' ? String(last.content || '') : '';
  if (chatView.open) rebuildChatLog();
}

/* --- Actions -------------------------------------------------------------- */
notch.onAction = (action) => {
  try {
    if (action === 'stop') {
      if (chatView.open && snapshot.status === 'chat') {
        api.chat.cancel();
        restoreChatAfterStop();
      } else {
        api.overlay.stop();
      }
      return;
    }
    if (action === 'copy') {
      if (snapshot.message) api.overlay.copy(snapshot.message);
      return;
    }
    if (action === 'retry') {
      api.overlay.retry();
      return;
    }
    if (action === 'settings') {
      api.overlay.openSettings();
      return;
    }
    if (action === 'allow' || action === 'deny') {
      const id = snapshot.approval?.id;
      if (id) api.overlay.approve(id, action === 'allow');
      return;
    }
    if (action === 'download-cancel') {
      api.overlay.cancelDownload?.();
      return;
    }
    if (action === 'collapse') {
      if (chatView.open && snapshot.status === 'chat') api.chat.close();
      else api.overlay.expand('collapsed');
    }
  } catch {
    // Every actionable call is guarded by preload; never crash the toast.
  }
};

notch.onChatSend = (text) => {
  if (!chatView.open) return;
  chatView.messages.push({ role: 'user', content: String(text), streaming: false });
  chatView.messages.push({ role: 'assistant', content: '', streaming: true });
  chatView.streaming = true;
  chatView.lastDelta = '';
  notch.chat.add('assistant', '');
  notch.chat.setStreaming(true);
  try {
    api.chat.send(text);
  } catch {
    applyChatError({ message: 'The message could not be sent.' });
  }
};

/* --- Cursor, audio, and speech ------------------------------------------- */
function updateHover(x, y) {
  if (!snapshot.visible) return;
  const rect = lastHit || notch.getHitRect();
  if (!rect) return;
  const inside = x >= rect.x && x <= rect.x + rect.width
    && y >= rect.y && y <= rect.y + rect.height;
  if (inside === hoverInside) return;
  hoverInside = inside;
  try {
    if (inside) api.overlay.pauseDismiss();
    else api.overlay.resumeDismiss();
  } catch {
    // A hidden overlay ignores these requests.
  }
}

function scheduleHideAcknowledge() {
  clearTimeout(hideAckTimer);
  hideAckTimer = setTimeout(() => {
    hideAckTimer = 0;
    if (!snapshot.visible) {
      try { api.overlay.hidden(); } catch { /* closing window */ }
    }
  }, 520);
}

api.overlay.onState((next) => {
  const wasVisible = snapshot.visible;
  snapshot = { ...snapshot, ...next, visible: next.visible !== false };
  if (!snapshot.visible) {
    hoverInside = false;
    lastHit = null;
    lastHitKey = '';
    clearTimeout(hideAckTimer);
    hideAckTimer = 0;
    renderSurface();
    scheduleHideAcknowledge();
    return;
  }
  clearTimeout(hideAckTimer);
  hideAckTimer = 0;
  if (!wasVisible) lastHitKey = '';
  renderSurface();
  if (!wasVisible) {
    requestAnimationFrame(() => {
      resendHitRect();
      requestAnimationFrame(() => {
        if (snapshot.visible) notch.getHitRect();
      });
    });
  }
});

api.overlay.onAudioLevel(({ peak, bins } = {}) => {
  notch.setLevel(clamp(Number(peak) || 0, 0, 1));
  if (Array.isArray(bins) && bins.length) {
    notch.setBands(bins.slice(0, BAND_COUNT).map((value) => clamp(Number(value) || 0, 0, 1)));
  }
});

api.overlay.onSpeechLevel?.((payload) => {
  if (snapshot.status !== 'answer' || !snapshot.speaking) return;
  notch.setLevel(clamp(Number(payload?.level) || 0, 0, 1));
});

api.overlay.onCursor?.((coords) => {
  if (!coords || !snapshot.visible) return;
  const x = Number(coords.x) || 0;
  const y = Number(coords.y) || 0;
  notch.setCursor(x, y);
  updateHover(x, y);
});

api.chat.onStarted(applyChatStarted);
api.chat.onDelta(applyChatDelta);
api.chat.onDone(applyChatDone);
api.chat.onError(applyChatError);
api.chat.onHistory(applyChatHistory);

window.addEventListener('pagehide', () => {
  clearTimeout(hideAckTimer);
  hideAckTimer = 0;
  notch.destroy();
});
