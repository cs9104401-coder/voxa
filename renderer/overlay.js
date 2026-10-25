'use strict';

const api = window.voiceAgent;
const $ = (selector) => document.querySelector(selector);
const notch = $('#notch');
const stage = $('#overlayStage');
const card = $('#notchCard');
const cardText = $('#cardText');
const stateLabel = $('#notchState');
const head = $('.pill-head');
const levelMeter = $('#levelMeter');
const approvalActions = $('#approvalActions');
const copyButton = $('#copyButton');
const collapseButton = $('#collapseButton');
const progressLine = $('#progressLine');
const progressFill = progressLine?.querySelector('i');
const stopButton = $('#stopButton');
const allowButton = $('#allowButton');
const denyButton = $('#denyButton');
const chatButton = $('#chatButton');
const chatCloseButton = $('#chatCloseButton');
const chatPanel = $('#chatPanel');
const chatLog = $('#chatLog');
const chatEmpty = $('#chatEmpty');
const chatForm = $('#chatForm');
const chatInput = $('#chatInput');
const chatHint = $('#chatHint');
const chatStopButton = $('#chatStopButton');
const chatSendButton = $('#chatSendButton');
const chatError = $('#chatError');
const chatPreviewLabel = $('#chatPreviewLabel');
const feedPanel = $('#feedPanel');
const mediaPanel = $('#mediaPanel');
const mediaTitle = $('#mediaTitle');
const mediaArtist = $('#mediaArtist');
const mediaControls = $('#mediaControls');
const mediaPrevButton = $('#mediaPrev');
const mediaPlayButton = $('#mediaPlay');
const mediaNextButton = $('#mediaNext');
const feedList = $('#feedList');
const feedCount = $('#feedCount');
const feedEmpty = $('#feedEmpty');
const feedPreviewLabel = $('#feedPreviewLabel');
const companion = $('#companion');
/* Stage 2 expanded-tab affordances: rail tabs, round settings button, and the
   Home card grid (preview media + real local time-of-day). */
const pillTabs = $('#pillTabs');
const tabButtons = [...document.querySelectorAll('.tab-button[data-tab]')];
const islandSettingsButton = $('#islandSettings');
const islandHome = $('#islandHome');
const homeMediaTitle = $('#homeMediaTitle');
const homeMediaArtist = $('#homeMediaArtist');
const homeMediaElapsed = $('#homeMediaElapsed');
const homeMediaTotal = $('#homeMediaTotal');
const homeMediaProgressFill = $('#homeMediaProgressFill');
const homeMediaPlayButton = $('#homeMediaPlay');
const homeMediaPrevButton = $('#homeMediaPrev');
const homeMediaNextButton = $('#homeMediaNext');
const timeCard = $('#timeCard');
const timeTitle = $('#timeTitle');
const timeSubtitle = $('#timeSubtitle');
const timeTemp = $('#timeTemp');
const timeDot = $('#timeDot');
const timeDotHalo = $('#timeDotHalo');
const timeArcPath = $('#timeArcPath');
const feedClearButton = $('#feedClearButton');
const retryButton = $('#retryButton');
const waveBars = [...(levelMeter?.querySelectorAll('i') || [])];
const spectrumCanvas = levelMeter ? levelMeter.querySelector('canvas') : null;
const spectrumCtx = spectrumCanvas && typeof spectrumCanvas.getContext === 'function' ? spectrumCanvas.getContext('2d') : null;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const MAX_CARD_HEIGHT = 400;
const MAX_ANIMATED_WORDS = 280;
// Pill geometry per size — must mirror the [data-size] band rules in island.css
// (--pad-x shared grid / band heights). scripts/island-capture.cjs cross-checks
// both at runtime. Stage-2 expanded: 640px wide, rail = the 52px tab row,
// strip = the 56px assistant head band, home = the 2-card Home body total.
const ISLAND_SIZES = {
  compact: { width: 208, height: 88 },
  medium: { width: 340, height: 104 },
  expanded: { width: 640, rail: 52, strip: 56, home: 190 }
};
const NOTCH_WIDTH = 660;
const MEDIUM_STATES = new Set(['thinking', 'executing', 'verifying', 'done', 'media']);
const EXPANDED_STATES = new Set(['answer', 'approval', 'error', 'chat', 'feed']);
const SUPPORTED_STATES = new Set(['idle', 'listening', ...MEDIUM_STATES, ...EXPANDED_STATES]);
// Stage 2 expanded-tab model: the pill reports the visible tab through
// data-tab. State patches steer the default (feed -> notifications, voice and
// answer states -> assistant); named expansions land on Home. The user can pin
// a different tab only while the pill is idle-expanded.
const TABS = new Set(['home', 'assistant', 'notifications']);
let pinnedTab = null;
function islandTabFor(status, expanded) {
  if (!expanded) return '';
  if (status === 'feed') return 'notifications';
  if (status === 'idle') return TABS.has(pinnedTab) ? pinnedTab : 'home';
  return 'assistant';
}
const CHAT_PREVIEW_MESSAGES = [
  { role: 'user', content: 'Give me a quick summary of my day.' },
  { role: 'assistant', content: 'You have three tasks left. The next one is a 2 pm review, then two short follow-ups.' }
];

let state = {
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
let chat = {
  requestId: 0,
  messages: [],
  streaming: false,
  error: ''
};
let lastText = null;
let lastStatus = '';
let respondedApprovalId = '';
let copyTimer = null;
let interactive = false;
let lastMouse = { x: Number.NaN, y: Number.NaN };
let hideAckSent = false;
let raf = 0;
let lastFrame = 0;
let levelTarget = 0;
let level = 0;
let wavePhase = 0;
// Phase C spectrum + speech metering. Bands come from the recorder mic graph;
// speech level comes from the TTS analyser tap. No synthetic sources.
const BAND_COUNT = 16;
let spectrumTarget = new Array(BAND_COUNT).fill(0);
let spectrumSmooth = new Array(BAND_COUNT).fill(0);
let spectrumUnit = null;
let spectrumDirty = false;
let speechTarget = 0;
let speechValue = 0;
let speechTrafficAt = 0;
let companionActMod = false;
let chatOpenedFor = false;
let wasChatVisible = false;
let chatFocusFrame = 0;
let chatRenderFrame = 0;
let companionBlinkTimer = null;
let companionBlinkOffTimer = null;
let companionWakeTimer = null;
let companionExpression = 'idle';
let companionPokeStamps = [];
let companionPokeTimer = null;
let companionDizzyTimer = null;
// Phase D feed choreography: ids present in the previous feed paint so a
// re-render (dismiss, state patch) never replays entrances for known cards.
let feedRenderedIds = new Set();

function reducedMotion() {
  return motionQuery.matches;
}

function slowFactor() {
  return state.slowMotion ? 4 : 1;
}

function companionExpressionFor(status) {
  if (status === 'listening') return 'listening';
  if (status === 'thinking' || status === 'executing' || status === 'verifying' || status === 'approval') return 'thinking';
  if (status === 'answer') return state.speaking ? 'speaking' : 'success';
  if (status === 'done') return 'success';
  if (status === 'error') return 'error';
  if (status === 'chat') return state.chatStreaming ? 'thinking' : 'idle';
  return 'idle';
}

// Moods with a fixed gaze: the eyes hold a static glance instead of tracking
// the cursor (thinking looks up-left; success/error faces are centered).
const COMPANION_STATIC_LOOK = {
  thinking: ['-0.9px', '-1.4px'],
  success: ['0px', '0px'],
  error: ['0px', '0px']
};

function resetCompanionLook() {
  if (!companion) return;
  const look = COMPANION_STATIC_LOOK[companionExpression] || ['0px', '0px'];
  companion.style.setProperty('--look-x', look[0]);
  companion.style.setProperty('--look-y', look[1]);
}

function updateCompanionLook(clientX, clientY) {
  if (!companion || !state.visible || state.companionEnabled === false || reducedMotion()) return;
  if (!companionExpression || COMPANION_STATIC_LOOK[companionExpression]) return;
  if (companion.classList.contains('is-dizzy') || companion.classList.contains('is-poked')) return;
  const rect = companion.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.max(-1, Math.min(1, (clientX - (rect.left + rect.width / 2)) / 80));
  const y = Math.max(-1, Math.min(1, (clientY - (rect.top + rect.height / 2)) / 60));
  companion.style.setProperty('--look-x', `${(x * 1.2).toFixed(2)}px`);
  companion.style.setProperty('--look-y', `${(y * 1).toFixed(2)}px`);
}

function clearCompanionBlink() {
  clearTimeout(companionBlinkTimer);
  clearTimeout(companionBlinkOffTimer);
  companionBlinkTimer = null;
  companionBlinkOffTimer = null;
  companion?.classList.remove('is-blinking');
}

function scheduleCompanionBlink() {
  if (!companion || !state.visible || state.companionEnabled === false || reducedMotion()) return;
  if (companionExpression === 'success' || companion.classList.contains('is-dizzy')) return;
  if (companionBlinkTimer || companionBlinkOffTimer) return;
  const slow = state.slowMotion ? 4 : 1;
  companionBlinkTimer = setTimeout(() => {
    companionBlinkTimer = null;
    if (!companion || !state.visible || state.companionEnabled === false || reducedMotion()) return;
    if (companionExpression === 'success' || companion.classList.contains('is-dizzy')) return;
    companion.classList.add('is-blinking');
    companionBlinkOffTimer = setTimeout(() => {
      companionBlinkOffTimer = null;
      companion?.classList.remove('is-blinking');
      scheduleCompanionBlink();
    }, Math.round(130 * slow));
  }, Math.round((3000 + Math.random() * 3000) * slow));
}

function pulseCompanionWake() {
  if (!companion || !state.visible || state.companionEnabled === false || reducedMotion()) return;
  companion.classList.remove('is-waking');
  void companion.offsetWidth; // force reflow so the one-shot entrance restarts from frame 0
  companion.classList.add('is-waking');
  if (companionWakeTimer) clearTimeout(companionWakeTimer);
  companionWakeTimer = setTimeout(() => {
    companionWakeTimer = null;
    companion?.classList.remove('is-waking');
  }, Math.round(850 * slowFactor()));
}

function syncCompanionMotion() {
  if (!companion) return;
  const enabled = state.companionEnabled !== false;
  notch.dataset.companion = enabled ? 'true' : 'false';
  if (!enabled || !state.visible || reducedMotion() || companionExpression === 'success') {
    clearCompanionBlink();
    if (!enabled || !state.visible || reducedMotion()) resetCompanionLook();
    return;
  }
  if (!companionBlinkTimer && !companionBlinkOffTimer) scheduleCompanionBlink();
}

function updateCompanion(status) {
  if (!companion) return;
  const expression = companionExpressionFor(status);
  if (companion.dataset.expression !== expression) {
    companion.dataset.expression = expression;
    companionExpression = expression;
    // Fixed-gaze moods (success/error/thinking) pin the eyes; tracking moods
    // re-glue to the cursor on the next feed frame.
    resetCompanionLook();
  }
  syncCompanionMotion();
}

function inline(parent, text) {
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(text))) {
    parent.append(document.createTextNode(text.slice(index, match.index)));
    const element = document.createElement(match[1] || match[2] ? 'strong' : 'code');
    element.textContent = match[1] || match[2] || match[3];
    parent.append(element);
    index = pattern.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(index)));
}

function markdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || '').split(/\r?\n/);
  let paragraph = [];
  let index = 0;
  function flush() {
    if (!paragraph.length) return;
    const element = document.createElement('p');
    inline(element, paragraph.join(' '));
    fragment.append(element);
    paragraph = [];
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

function wrapWords(fragment) {
  const holder = document.createElement('div');
  holder.append(fragment);
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let wordIndex = 0;
  const baseDelay = 18 * slowFactor();
  for (const node of nodes) {
    if (node.parentElement?.closest('pre, code')) continue;
    const parts = String(node.nodeValue || '').split(/(\s+)/);
    const replacement = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part) || wordIndex >= MAX_ANIMATED_WORDS) {
        replacement.append(document.createTextNode(part));
        continue;
      }
      const word = document.createElement('span');
      word.className = 'word';
      word.textContent = part;
      word.style.animationDelay = `${Math.round(wordIndex * baseDelay)}ms`;
      replacement.append(word);
      wordIndex += 1;
    }
    node.parentNode?.replaceChild(replacement, node);
  }
  const output = document.createDocumentFragment();
  while (holder.firstChild) output.append(holder.firstChild);
  return output;
}

function setLabel(text) {
  if (stateLabel.textContent === text) return;
  const previous = stateLabel.textContent;
  const center = stateLabel.parentElement;
  if (previous && center && notch.dataset.size !== 'compact') {
    const ghost = document.createElement('span');
    ghost.className = 'label-ghost';
    ghost.textContent = previous;
    center.append(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  }
  stateLabel.textContent = text;
  stateLabel.classList.remove('label-enter');
  void stateLabel.offsetWidth;
  stateLabel.classList.add('label-enter');
}

function setCardText(text, streamWords) {
  if (text === lastText) return;
  if (cardText.childNodes.length && lastText !== null) {
    const ghost = document.createElement('div');
    ghost.className = 'card-ghost';
    ghost.replaceChildren(...Array.from(cardText.childNodes, (n) => n.cloneNode(true)));
    card.append(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  }
  const content = markdown(text);
  cardText.replaceChildren(streamWords ? wrapWords(content) : content);
  cardText.classList.toggle('streaming', Boolean(streamWords));
  cardText.classList.remove('text-enter');
  void cardText.offsetWidth;
  cardText.classList.add('text-enter');
  cardText.scrollTop = 0;
  updateScrollFade();
  lastText = text;
}

function chatVisible() {
  return Boolean(state.visible && state.chatOpen && notch.dataset.state === 'chat');
}

function voiceBusy() {
  return ['listening', 'thinking', 'executing', 'verifying', 'approval'].includes(state.status);
}

function updateChatComposer() {
  if (!chatInput) return;
  const preview = Boolean(state.chatPreview);
  chatInput.disabled = preview;
  chatSendButton.disabled = preview || chat.streaming || !chatInput.value.trim();
  chatStopButton.hidden = !chat.streaming || preview;
  chatStopButton.disabled = !chat.streaming;
  chatHint.textContent = preview
    ? 'Preview only'
    : chat.streaming ? 'Reply in progress…' : 'Enter to send · Shift+Enter for a new line';
  chatError.hidden = !chat.error;
  chatError.textContent = chat.error || '';
  chatPreviewLabel.hidden = !preview;
  chatPanel.dataset.preview = preview ? 'true' : 'false';
  chatInput.style.height = 'auto';
  const maxHeight = 96;
  const nextHeight = Math.min(maxHeight, Math.max(24, chatInput.scrollHeight || 24));
  chatInput.style.height = `${nextHeight}px`;
  chatInput.style.overflowY = (chatInput.scrollHeight || 0) > maxHeight ? 'auto' : 'hidden';
}

function renderChatLog() {
  if (!chatLog) return;
  chatLog.querySelectorAll('.chat-message').forEach((node) => node.remove());
  const messages = state.chatPreview ? CHAT_PREVIEW_MESSAGES : chat.messages;
  chatEmpty.hidden = messages.length > 0;
  for (const message of messages) {
    const item = document.createElement('div');
    const isUser = message.role === 'user';
    item.className = `chat-message ${isUser ? 'is-user' : 'is-assistant'}`;
    if (message.streaming) item.classList.add('is-streaming');
    if (message.cancelled) item.classList.add('is-cancelled');
    if (message.error) item.classList.add('is-error');
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = isUser ? 'You' : (api.appName || 'Voxa');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    if (!isUser && !message.streaming && message.content) bubble.append(markdown(message.content));
    else bubble.textContent = message.content || '';
    if (message.streaming) {
      const caret = document.createElement('span');
      caret.className = 'chat-caret';
      caret.setAttribute('aria-hidden', 'true');
      bubble.append(caret);
    }
    item.append(who, bubble);
    if (message.cancelled) {
      const note = document.createElement('div');
      note.className = 'chat-note';
      note.textContent = 'Stopped';
      item.append(note);
    } else if (message.error) {
      const note = document.createElement('div');
      note.className = 'chat-note is-error';
      note.textContent = message.error;
      item.append(note);
    }
    chatLog.append(item);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function updateChatDeltaView() {
  const last = chat.messages[chat.messages.length - 1];
  const items = chatLog?.querySelectorAll('.chat-message') || [];
  const item = items[items.length - 1];
  const bubble = item?.querySelector('.chat-bubble');
  if (!last || last.role !== 'assistant' || !item?.classList.contains('is-assistant') || !bubble
    || item.classList.contains('is-error') || item.classList.contains('is-cancelled')) {
    renderChatLog();
    return;
  }
  bubble.textContent = last.content || '';
  if (last.streaming) {
    const caret = document.createElement('span');
    caret.className = 'chat-caret';
    caret.setAttribute('aria-hidden', 'true');
    bubble.append(caret);
  }
  chatEmpty.hidden = true;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function scheduleChatDeltaRender() {
  if (chatRenderFrame) return;
  chatRenderFrame = requestAnimationFrame(() => {
    chatRenderFrame = 0;
    updateChatDeltaView();
    if (chatVisible()) retarget();
  });
}

function updateChatHeader() {
  const open = notch.dataset.state === 'chat' && state.chatOpen;
  const preview = Boolean(state.chatPreview);
  // Media pill owns the actions row: chat/stop would be decorative there (the
  // ESC hotkey keeps its snooze path in main.cjs), so only transport shows.
  const mediaOpen = notch.dataset.state === 'media';
  chatButton.hidden = !state.visible || open || preview || voiceBusy() || mediaOpen;
  chatCloseButton.hidden = !state.visible || !open || preview;
  stopButton.hidden = open || mediaOpen;
  if (open) setLabel(statusLabel('chat'));
}

function focusChatInput() {
  if (!chatVisible() || state.chatPreview) return;
  cancelAnimationFrame(chatFocusFrame);
  chatFocusFrame = requestAnimationFrame(() => {
    chatFocusFrame = 0;
    if (!chatVisible() || state.chatPreview) return;
    chatInput.focus({ preventScroll: true });
    const end = chatInput.value.length;
    try {
      chatInput.setSelectionRange(end, end);
    } catch {
      // The textarea may not support selection while disabled.
    }
  });
}

function sendChatMessage() {
  if (!chatVisible() || state.chatPreview || chat.streaming) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chat.error = '';
  chat.messages.push({ role: 'user', content: text });
  chat.streaming = true;
  chatInput.value = '';
  updateChatComposer();
  renderChatLog();
  updateChatHeader();
  retarget();
  try {
    api.chat.send(text);
  } catch {
    applyChatError({ message: 'The message could not be sent.' });
  }
}

function applyChatHistory(payload) {
  if (!payload || !Array.isArray(payload.messages)) return;
  chat.messages = payload.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: String(message.content || ''),
      streaming: Boolean(message.streaming),
      cancelled: Boolean(message.cancelled),
      error: message.error ? String(message.error) : ''
    }));
  chat.streaming = Boolean(payload.streaming);
  chat.requestId = Number(payload.requestId) || chat.requestId;
  chat.error = '';
  updateChatComposer();
  renderChatLog();
  updateChatHeader();
  retarget();
}

function applyChatStarted(payload) {
  const id = Number(payload?.id) || 0;
  if (!id) return;
  chat.requestId = id;
  chat.streaming = true;
  chat.error = '';
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.streaming) {
    const text = typeof payload.text === 'string' ? payload.text : '';
    const lastUser = [...chat.messages].reverse().find((message) => message.role === 'user');
    if (text && (!lastUser || lastUser.content !== text)) chat.messages.push({ role: 'user', content: text });
    chat.messages.push({ role: 'assistant', content: '', streaming: true });
  }
  updateChatComposer();
  renderChatLog();
  updateChatHeader();
  retarget();
}

function applyChatDelta(payload) {
  if (!payload || Number(payload.id) !== chat.requestId) return;
  const text = typeof payload.text === 'string' ? payload.text : '';
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== 'assistant') {
    chat.messages.push({ role: 'assistant', content: text, streaming: true });
  } else {
    last.content = text;
    last.streaming = true;
    last.cancelled = false;
    last.error = '';
  }
  chat.streaming = true;
  chat.error = '';
  updateChatComposer();
  updateChatHeader();
  scheduleChatDeltaRender();
}

function applyChatDone(payload) {
  if (!payload) return;
  const id = Number(payload.id) || 0;
  if (id && id !== chat.requestId) return;
  const text = typeof payload.text === 'string' ? payload.text : '';
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== 'assistant') {
    chat.messages.push({ role: 'assistant', content: text, cancelled: Boolean(payload.cancelled) });
  } else {
    last.content = text;
    last.streaming = false;
    last.cancelled = Boolean(payload.cancelled);
    last.error = '';
  }
  chat.streaming = false;
  chat.error = '';
  updateChatComposer();
  renderChatLog();
  updateChatHeader();
  retarget();
}

function applyChatError(payload) {
  if (!payload) return;
  const id = Number(payload.id) || 0;
  if (id && id !== chat.requestId) return;
  const message = String(payload.message || 'The reply failed.');
  if (id) {
    const last = chat.messages[chat.messages.length - 1];
    if (!last || last.role !== 'assistant') {
      chat.messages.push({ role: 'assistant', content: '', error: message });
    } else {
      last.streaming = false;
      last.error = message;
    }
    chat.streaming = false;
  } else {
    const last = chat.messages[chat.messages.length - 1];
    chat.error = message;
    if (!(chat.streaming && last?.role === 'assistant' && last.streaming)) {
      chat.streaming = false;
      if (last?.role === 'assistant' && last.streaming && !last.content) chat.messages.pop();
      if (last?.role === 'user' && !chatInput.value.trim()) {
        chat.messages.pop();
        chatInput.value = last.content;
      }
    }
  }
  updateChatComposer();
  renderChatLog();
  updateChatHeader();
  retarget();
}

function statusLabel(status) {
  const mapping = {
    idle: 'Idle',
    listening: 'Listening',
    thinking: state.message || 'Thinking…',
    executing: state.message || 'Working…',
    verifying: state.message || 'Checking…',
    answer: `${api.appName} replied`,
    approval: 'Approval needed',
    error: 'Needs attention',
    done: 'Done',
    chat: state.chatPreview ? 'Chat preview' : chat.streaming ? 'Replying…' : 'Ask Voxa',
    feed: 'Alerts',
    media: 'Now playing'
  };
  return mapping[status] || status;
}

function sizeFor(status) {
  // The media pill is always its medium band; pinned expansion must not turn
  // it into a wide rail with an empty card.
  if (status === 'media') return 'medium';
  // A resting pill that carries content (Phase H download, Phase G unread
  // alerts) uses the medium band: compact hides the state label by design, so
  // text-only affordances would be invisible there. Plain idle stays compact.
  if (status === 'idle' && (state.download || state.notifications.length)) return 'medium';
  if (state.expand === 'collapsed') {
    const chatMode = status === 'chat' && Boolean(state.chatOpen);
    if (!chatMode && status !== 'approval') return 'compact';
  }
  if (EXPANDED_STATES.has(status)) return 'expanded';
  if (state.expand === 'pinned') return 'expanded';
  if (MEDIUM_STATES.has(status)) return 'medium';
  return 'compact';
}

function contentWidthFor(size) {
  if (state.style === 'notch') return NOTCH_WIDTH;
  return size === 'expanded' ? ISLAND_SIZES.expanded.width : ISLAND_SIZES[size].width;
}

function measureCard(contentWidth) {
  const clone = card.cloneNode(true);  clone.removeAttribute('id');
  clone.removeAttribute('aria-live');
  clone.removeAttribute('data-scrolled');
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.classList.add('measure-card');
  clone.style.width = `${contentWidth}px`;
  document.body.append(clone);
  const height = clone.getBoundingClientRect().height;
  clone.remove();
  return height;
}

function measureChat(contentWidth) {
  const clone = chatPanel.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.classList.add('measure-chat');
  clone.hidden = false;
  clone.style.width = `${contentWidth}px`;
  const textarea = clone.querySelector('textarea');
  if (textarea) {
    textarea.value = chatInput.value;
    textarea.style.height = chatInput.style.height || 'auto';
  }
  document.body.append(clone);
  const height = clone.getBoundingClientRect().height;
  clone.remove();
  return height;
}

function measureFeed(contentWidth) {
  if (!feedPanel) return 140;
  const clone = feedPanel.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.classList.add('measure-feed');
  clone.hidden = false;
  clone.style.width = `${contentWidth}px`;
  document.body.append(clone);
  const height = clone.getBoundingClientRect().height;
  clone.remove();
  return Math.max(96, height);
}

// Home body is a fixed 2-card grid (preview media + real local time card), so
// the clone measure stays deterministic; the constant is the fallback when the
// panel is missing (never in the shipped markup).
function measureHome(contentWidth) {
  if (!islandHome) return ISLAND_SIZES.expanded.home - ISLAND_SIZES.expanded.rail - 2;
  const clone = islandHome.cloneNode(true);
  clone.removeAttribute('id');
  clone.hidden = false;
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.classList.add('measure-home');
  clone.style.width = `${contentWidth}px`;
  // The clone leaves the .pill scope, so --pad-x (defined on .pill in island.css)
  // is unresolved there and the attached padding would compute to 0. Feed the
  // live computed value so the clone measures with the pill's real shared pad.
  const padX = getComputedStyle(notch).getPropertyValue('--pad-x').trim();
  if (padX) clone.style.setProperty('--pad-x', padX);
  document.body.append(clone);
  const height = clone.getBoundingClientRect().height;
  clone.remove();
  return height;
}

/* --- Notification feed (Ref 1) -------------------------------------------- */
/* Items come from main through overlay:state (gallery samples in Phase B;
   real producers arrive in the voice/telemetry phases). Timestamps render
   relative to "now" at paint time. Build with DOM APIs only — textContent
   everywhere, no innerHTML from state data. */
const FEED_ICON_PATHS = {
  turn: ['m5 12.6 4.5 4.5L19 7.4'],
  download: ['M12 4v10m0 0-4-4m4 4 4-4', 'M5 20h14'],
  media: ['M10.2 9.2v5.6l4.6-2.8z', 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z'],
  system: ['M4 7h9', 'M4 12h14', 'M4 17h7'],
  error: ['M12 3.8 2.9 20.2h18.2z', 'M12 9v5.2m0 2.9v.1']
};

function feedGlyph(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of FEED_ICON_PATHS[kind] || FEED_ICON_PATHS.system) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function relTime(ts) {
  const stamp = Number(ts);
  if (!stamp) return '';
  const diff = Math.max(0, Date.now() - stamp);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(stamp).toLocaleDateString();
}

function feedSection(label) {
  const section = document.createElement('span');
  section.className = 'feed-section';
  section.setAttribute('aria-hidden', 'true');
  section.textContent = label;
  return section;
}

function feedItem(item) {
  const node = document.createElement('article');
  node.className = `feed-item ${item.tone === 'highlight' ? 'is-highlight' : ''}`;
  node.setAttribute('role', 'listitem');
  const thumb = document.createElement('span');
  thumb.className = 'feed-thumb';
  thumb.append(feedGlyph(item.kind));
  const main = document.createElement('div');
  main.className = 'feed-main';
  const title = document.createElement('span');
  title.className = 'feed-item-title';
  title.textContent = String(item.title || 'Alert');
  const body = document.createElement('span');
  body.className = 'feed-item-body';
  const bodyText = String(item.body || '');
  if (bodyText) body.textContent = bodyText;
  else body.hidden = true;
  const meta = document.createElement('span');
  meta.className = 'feed-meta';
  const when = relTime(item.ts);
  meta.textContent = `${api.appName || 'Voxa'}${when ? ` · ${when}` : ''}`;
  main.append(title, body, meta);
  const dismiss = document.createElement('button');
  dismiss.className = 'feed-x';
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', `Dismiss alert: ${title.textContent}`);
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('viewBox', '0 0 24 24');
  glyph.setAttribute('aria-hidden', 'true');
  const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  cross.setAttribute('d', 'M6 6l12 12M18 6 6 18');
  glyph.append(cross);
  dismiss.append(glyph);
  dismiss.addEventListener('click', () => {
    if (!item.id) return;
    try {
      api.overlay.dismissNotification(String(item.id));
    } catch {
      // Blocked channel guard in preload; the feed stays until repaint.
    }
  });
  node.append(thumb, main, dismiss);
  return node;
}

function renderFeed() {
  if (!feedPanel) return;
  const items = Array.isArray(state.notifications) ? state.notifications : [];
  feedCount.textContent = items.length ? `${items.length} alert${items.length === 1 ? '' : 's'}` : 'All clear';
  feedPreviewLabel.hidden = !state.feedPreview;
  feedEmpty.hidden = items.length > 0;
  if (feedClearButton) feedClearButton.hidden = items.length === 0;
  feedList.replaceChildren();
  items.forEach((item, index) => {
    if (index === 0) feedList.append(feedSection('New'));
    else if (index === 1) feedList.append(feedSection('Old'));
    const node = feedItem(item);
    // Ref 1 cascade: cards drop into the stack one after another, staggered by
    // position. Reduced motion swaps to a pure opacity wave (feed-fade), so the
    // rhythm stays visible without translating or blurring anything.
    const id = String(item.id || '');
    const fresh = Boolean(id) && !feedRenderedIds.has(id);
    if (fresh) {
      node.classList.add('feed-enter');
      node.style.animationDelay = `${Math.round(index * 36 * slowFactor())}ms`;
    }
    feedList.append(node);
  });
  feedRenderedIds = new Set(items.map((item) => String(item.id || '')).filter(Boolean));
  feedList.scrollTop = 0;
}

function targetGeometry() {
  const status = notch.dataset.state;
  const size = sizeFor(status);
  const expanded = size === 'expanded';
  const tab = islandTabFor(status, expanded);
  const assistantMode = expanded && tab === 'assistant';
  const chatMode = assistantMode && status === 'chat' && Boolean(state.chatOpen);
  const feedMode = expanded && tab === 'notifications';
  const homeMode = expanded && tab === 'home';
  const contentWidth = contentWidthFor(size);
  notch.style.setProperty('--content-width', `${contentWidth}px`);
  // Expanded stacks: tab rail (always) + assistant strip (Assistant tab only,
  // it carries blob/meter/actions) + the body of the active tab. Head band
  // heights are static CSS dimensions (mirrored in ISLAND_SIZES), so the
  // constants drive the math instead of DOM probing.
  const rail = expanded ? ISLAND_SIZES.expanded.rail : ISLAND_SIZES[size].height;
  const strip = assistantMode ? ISLAND_SIZES.expanded.strip : 0;
  // The main process reports the usable stage height for the active display
  // (window height minus top gap and shadow clearance). Clamp the measured body
  // so the whole pill — including shadow and divider — stays inside the window
  // even on small or heavily scaled displays. Falls back unclamped when absent.
  const stageMax = Number(state.stageMax);
  const bodyLimit = Number.isFinite(stageMax) && stageMax > 0
    ? Math.max(96, stageMax - rail - strip - 2)
    : Number.POSITIVE_INFINITY;
  const cardHeight = assistantMode && !chatMode
    ? Math.min(MAX_CARD_HEIGHT, measureCard(contentWidth), bodyLimit)
    : 0;
  const chatHeight = chatMode
    ? Math.min(MAX_CARD_HEIGHT, measureChat(contentWidth), bodyLimit)
    : 0;
  const feedHeight = feedMode
    ? Math.min(MAX_CARD_HEIGHT, measureFeed(contentWidth), bodyLimit)
    : 0;
  const homeHeight = homeMode
    ? Math.min(MAX_CARD_HEIGHT, measureHome(contentWidth), bodyLimit)
    : 0;
  const bodyHeight = chatMode ? chatHeight : feedMode ? feedHeight : homeMode ? homeHeight : cardHeight;
  let width;
  let height;
  let radius;
  if (state.style === 'notch') {
    width = NOTCH_WIDTH;
    height = chatMode
      ? Math.max(rail + strip + 38, Math.round(rail + strip + chatHeight + 2))
      : expanded
        ? Math.round(rail + strip + bodyHeight + 2)
        : rail;
    radius = 22;
  } else {
    width = contentWidth;
    height = chatMode
      ? Math.max(rail + strip + 38, Math.round(rail + strip + chatHeight + 2))
      : expanded
        ? Math.round(rail + strip + bodyHeight + 2)
        : ISLAND_SIZES[size].height;
    radius = expanded ? 34 : size === 'medium' ? 24 : height / 2;
  }
  return { width, height, radius };
}

class Spring {
  constructor(value, stiffness = 170, damping = 20) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  setTarget(target, immediate = false) {
    this.target = target;
    if (immediate) {
      this.value = target;
      this.velocity = 0;
    }
  }

  step(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const slice = dt / steps;
    for (let index = 0; index < steps; index += 1) {
      const acceleration = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += acceleration * slice;
      this.value += this.velocity * slice;
    }
    if (Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}

const springs = {
  // Phase D retune: a touch snappier than the stock numbers so the island grows
  // with intent and settles soft. Kept well within the harness settle waits.
  width: new Spring(ISLAND_SIZES.compact.width, 185, 22),
  height: new Spring(ISLAND_SIZES.compact.height, 185, 22),
  radius: new Spring(ISLAND_SIZES.compact.height / 2, 185, 22),
  scale: new Spring(0.14, 220, 22),
  opacity: new Spring(0, 200, 24),
  blur: new Spring(0, 220, 24)
};

function applyGeometry() {
  const notchStyle = state.style === 'notch';
  const radius = Math.max(0, springs.radius.value);
  notch.style.width = `${springs.width.value.toFixed(2)}px`;
  notch.style.height = `${springs.height.value.toFixed(2)}px`;
  notch.style.borderRadius = notchStyle ? `0 0 ${radius.toFixed(2)}px ${radius.toFixed(2)}px` : `${radius.toFixed(2)}px`;
  notch.style.opacity = `${Math.max(0, Math.min(1, springs.opacity.value)).toFixed(3)}`;
  notch.style.transform = reducedMotion() ? 'none' : `scale(${Math.max(0.06, springs.scale.value).toFixed(3)})`;
  notch.style.filter = springs.blur.value > 0.06 ? `blur(${springs.blur.value.toFixed(2)}px)` : 'none';
}

function retarget(immediate = false) {
  const target = targetGeometry();
  const instant = immediate || reducedMotion();
  springs.width.setTarget(target.width, instant);
  springs.height.setTarget(target.height, instant);
  springs.radius.setTarget(target.radius, instant);
  springs.blur.setTarget(0, instant);
  if (state.visible) {
    springs.scale.setTarget(1, instant);
    springs.opacity.setTarget(1, false);
  } else {
    springs.scale.setTarget(reducedMotion() ? 1 : 0.12, instant);
    springs.opacity.setTarget(0, false);
  }
  startLoop();
}

function updateWave(dt) {
  const active = state.visible && notch.dataset.state === 'listening';
  if (active) {
    const tau = levelTarget > level ? 0.06 : 0.18;
    level += (levelTarget - level) * (1 - Math.exp(-dt / tau));
    wavePhase += dt;
  } else {
    level += (0 - level) * (1 - Math.exp(-dt / 0.1));
  }
  const amount = Math.max(0.12, Math.min(1, level));
  waveBars.forEach((bar, index) => {
    const bias = 0.62 + 0.38 * Math.sin(((index + 0.5) / waveBars.length) * Math.PI);
    const wobble = 0.52 + 0.48 * Math.sin(wavePhase * 7 + index * 1.18) ** 2;
    const scale = active ? 0.16 + amount * bias * wobble * 0.84 : 0.14;
    bar.style.setProperty('--bar', Math.min(1, scale).toFixed(3));
  });
}

function updateProgress() {
  const dismiss = state.dismiss;
  if (!dismiss || !dismiss.duration || !state.visible) {
    progressLine.dataset.active = 'false';
    return;
  }
  progressLine.dataset.active = 'true';
  let ratio;
  if (dismiss.paused) {
    ratio = Math.max(0, Math.min(1, Number(dismiss.remaining ?? dismiss.duration) / dismiss.duration));
  } else {
    ratio = 1 - (Date.now() - Number(dismiss.startedAt || Date.now())) / dismiss.duration;
  }
  progressFill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio)).toFixed(4)})`;
}

function settled() {
  return Object.values(springs).every((spring) => (
    Math.abs(spring.target - spring.value) < 0.01 && Math.abs(spring.velocity) < 0.05
  ));
}

function loopNeeded() {
  if (state.visible && notch.dataset.state === 'listening') return true;
  if (speakingActive()) return true;
  if (state.visible && state.dismiss && !state.dismiss.paused) return true;
  return !settled();
}

function frame(now) {
  raf = 0;
  const rawDt = Math.min(0.05, Math.max(0.001, (now - (lastFrame || now)) / 1000));
  lastFrame = now;
  const dt = rawDt * (state.slowMotion ? 0.25 : 1);
  Object.values(springs).forEach((spring) => spring.step(dt));
  updateWave(dt);
  updateSpectrum(rawDt);
  updateSpeech(rawDt);
  updateProgress();
  applyGeometry();
  if (!state.visible && !hideAckSent && settled()) {
    hideAckSent = true;
    api.overlay.hidden();
  }
  if (loopNeeded()) {
    raf = requestAnimationFrame(frame);
  } else {
    lastFrame = 0;
  }
}

function startLoop() {
  if (raf) return;
  lastFrame = 0;
  raf = requestAnimationFrame(frame);
}

function requestInteractive(next) {
  const wanted = Boolean(next) || (chatVisible() && !state.chatPreview);
  if (interactive === wanted) return;
  interactive = wanted;
  api.overlay.interactive(wanted);
}

// The hover demand covers whatever rect the pill actually renders: collapsed
// and medium bands keep the classic pill ±5px field, while any expanded band
// (data-size=expanded: answer/approval/error/chat/feed or a pinned idle) uses
// the full pill rect plus a 6px halo so every part of the panel — not only the
// hover-gated head — keeps the window interactive. #notch IS the .pill root,
// so one rect serves both.
function hoverPadding() {
  return sizeFor(notch.dataset.state) === 'expanded' ? 6 : 5;
}

function insideNotch(x, y) {
  const rect = notch.getBoundingClientRect();
  const padding = hoverPadding();
  return x >= rect.left - padding && x <= rect.right + padding
    && y >= rect.top - padding && y <= rect.bottom + padding;
}

/* --- Shape-based hit testing (replaces hover-driven click-through) ---------- */
/* The window accepts native input whenever the pill is visible; main applies
   window-relative window.setShape regions from this renderer, so clicks on the
   pill land here and clicks anywhere else pass to whatever is under the
   island. Sends are rAF-coalesced (fires after layout, covers spring morph
   frames) and deduped by integer rect so repeated renders never flood IPC. */
const HIT_RECT_PAD = 6;
let hitRectQueued = false;
let hitRectSignature = null;

function hitRectPayload() {
  const rect = notch.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const left = Math.floor(rect.left);
  const top = Math.floor(rect.top);
  return {
    x: left - HIT_RECT_PAD,
    y: top - HIT_RECT_PAD,
    width: Math.ceil(rect.right) + HIT_RECT_PAD - (left - HIT_RECT_PAD),
    height: Math.ceil(rect.bottom) + HIT_RECT_PAD - (top - HIT_RECT_PAD)
  };
}

function sendHitRect() {
  if (hitRectQueued) return;
  hitRectQueued = true;
  requestAnimationFrame(() => {
    hitRectQueued = false;
    if (!state.visible) return;
    const payload = hitRectPayload();
    if (!payload) return;
    const signature = `${payload.x},${payload.y},${payload.width},${payload.height}`;
    if (signature === hitRectSignature) return;
    hitRectSignature = signature;
    try { api.overlay.hitRect(payload); } catch { /* send failures stay isolated */ }
  });
}

function updateScrollFade() {
  const max = cardText.scrollHeight - cardText.clientHeight;
  const scrolled = cardText.scrollTop > 4;
  const moreBelow = max > 8 && cardText.scrollTop < max - 4;
  notch.dataset.scrolled = scrolled ? 'true' : 'false';
  notch.dataset.moreBelow = moreBelow ? 'true' : 'false';
  card.dataset.scrolled = scrolled ? 'true' : 'false';
}

/* --- Home tab (Stage 2) ----------------------------------------------------- */
/* Media card runs on the adapter mock and always carries the Preview badge;
   nothing here touches the real SMTC pipeline (that stays on the medium band).
   The time card is the honest one: the local clock drives gradient, title and
   the glowing arc dot, and temperature renders "--" until real weather lands. */
function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function positionTimeDot(minutes) {
  if (!timeArcPath || !timeDot || typeof timeArcPath.getTotalLength !== 'function') return;
  const length = timeArcPath.getTotalLength();
  if (!length) return;
  const fraction = Math.max(0, Math.min(1, (Number(minutes) || 0) / 1440));
  const point = timeArcPath.getPointAtLength(fraction * length);
  timeDot.setAttribute('cx', point.x.toFixed(1));
  timeDot.setAttribute('cy', point.y.toFixed(1));
  if (timeDotHalo) {
    timeDotHalo.setAttribute('cx', point.x.toFixed(1));
    timeDotHalo.setAttribute('cy', point.y.toFixed(1));
  }
}

function renderHome() {
  if (!islandHome || islandHome.hidden) return;
  const adapters = window.islandAdapters || null;
  const media = adapters?.getMedia?.() || null;
  if (media) {
    if (homeMediaTitle) homeMediaTitle.textContent = String(media.title || 'Preview track');
    if (homeMediaArtist) {
      homeMediaArtist.textContent = [media.artist, media.album].filter(Boolean).join(' · ');
    }
    const ratio = Number(media.duration) > 0
      ? Math.max(0, Math.min(1, Number(media.position) / Number(media.duration)))
      : 0;
    if (homeMediaProgressFill) homeMediaProgressFill.style.width = `${Math.round(ratio * 100)}%`;
    if (homeMediaElapsed) homeMediaElapsed.textContent = formatClock(media.position);
    if (homeMediaTotal) homeMediaTotal.textContent = formatClock(media.duration);
    notch.dataset.homePlaying = media.playing ? 'true' : 'false';
    const locked = media.controls === false;
    if (homeMediaPlayButton) homeMediaPlayButton.disabled = locked;
    if (homeMediaPrevButton) homeMediaPrevButton.disabled = locked;
    if (homeMediaNextButton) homeMediaNextButton.disabled = locked;
  }
  const weather = adapters?.getWeather?.() || null;
  const time = adapters?.getTimeOfDay?.() || null;
  if (!timeCard || !time) return;
  timeCard.dataset.phase = time.phase;
  if (timeTitle) timeTitle.textContent = String(time.label || 'Day');
  if (timeSubtitle) {
    const now = new Date();
    const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
    timeSubtitle.textContent = `${weekday} · ${now.toTimeString().slice(0, 5)} local`;
  }
  const tempC = weather && weather.tempC != null ? Number(weather.tempC) : null;
  if (timeTemp) timeTemp.textContent = tempC != null && Number.isFinite(tempC) ? `${Math.round(tempC)}°` : '--';
  positionTimeDot(time.minutes);
}

function render() {
  const status = SUPPORTED_STATES.has(state.status) ? state.status : 'thinking';
  const size = sizeFor(status);
  const style = state.style === 'notch' ? 'notch' : 'island';
  const openChat = status === 'chat' && state.chatOpen;
  const interactiveChat = openChat && !state.chatPreview;
  const wasVisible = notch.dataset.visible === 'true';
  const wasSize = notch.dataset.size;
  // Stage 2 tab model: state patches steer the tab; the user's pinned choice
  // survives only while the pill rests idle-expanded.
  if (size !== 'expanded') pinnedTab = null;
  const tab = islandTabFor(status, size === 'expanded');
  notch.dataset.state = status;
  notch.dataset.size = size;
  // Growing under a resting cursor must not swallow the first click: every
  // show() pushes the window back to click-through, so when the pill expands
  // while the pointer already sits on it, demand interactive right away (last
  // known position; NaN before the first forwarded move keeps this a no-op).
  if (state.visible && size === 'expanded' && wasSize !== 'expanded'
    && insideNotch(lastMouse.x, lastMouse.y)) {
    requestInteractive(true);
  }
  notch.dataset.tab = tab;
  notch.dataset.style = style;
  notch.dataset.visible = state.visible ? 'true' : 'false';
  notch.dataset.mode = state.mode || 'agent';
  notch.dataset.speaking = state.speaking ? 'true' : 'false';
  notch.dataset.scrolled = cardText.scrollTop > 4 ? 'true' : 'false';
  stage.dataset.style = style;
  updateCompanion(status);
  if (!wasVisible && state.visible) pulseCompanionWake();
  document.body.classList.toggle('slow-motion', Boolean(state.slowMotion));
  document.body.dataset.reducedMotion = reducedMotion() ? 'true' : 'false';
  // Resting pill advertises the unread event stack with a real count — that
  // is the click affordance for the live feed (Phase G). A live model
  // download (Phase H) outranks it: it is the current long activity and the
  // count is still one click away. The pill only moves on real percent steps
  // — never a fake animation.
  let labelText = statusLabel(status);
  if (status === 'idle' && state.download) {
    const download = state.download;
    const tail = download.phase === 'downloading' && download.percent != null
      ? ` · ${download.percent}%`
      : download.phase === 'loading' ? ' · loading' : '';
    labelText = `${download.label}${tail}`;
  } else if (status === 'idle' && state.notifications.length) {
    labelText = `Alerts · ${state.notifications.length}`;
  }
  setLabel(labelText);
  const approvalId = state.approval?.id || '';
  if (approvalId !== respondedApprovalId) respondedApprovalId = '';
  notch.dataset.approvalId = approvalId;
  approvalActions.hidden = status !== 'approval' || !state.approval;
  approvalActions.querySelectorAll('button').forEach((button) => {
    button.disabled = Boolean(approvalId && respondedApprovalId === approvalId);
  });
  copyButton.hidden = !state.canCopy;
  if (copyButton.textContent === 'Copied') {
    clearTimeout(copyTimer);
    copyTimer = null;
    copyButton.textContent = 'Copy';
  }
  collapseButton.hidden = !(state.visible
    && notch.dataset.size === 'expanded'
    && status !== 'approval'
    && !openChat);
  const openFeed = status === 'feed';
  // Stage 2 expanded tabs: the tab rail shows only when expanded, the head band
  // (blob strip) only on the Assistant tab, and the Home grid takes the body
  // whenever it is the active tab.
  if (pillTabs) pillTabs.hidden = size !== 'expanded';
  const homeMode = size === 'expanded' && tab === 'home';
  tabButtons.forEach((button) => {
    button.classList.toggle('is-active', size === 'expanded' && button.dataset.tab === tab);
  });
  if (retryButton) retryButton.hidden = status !== 'error';
  card.hidden = openChat || openFeed || homeMode;
  chatPanel.hidden = !openChat;
  if (feedPanel) feedPanel.hidden = !openFeed;
  if (islandHome) islandHome.hidden = !homeMode;
  if (homeMode) renderHome();
  // Phase F media band: the pill renders real SMTC metadata only when the
  // media status is up; the transport row behaves even without the mascot.
  const media = status === 'media' && state.media && typeof state.media === 'object' ? state.media : null;
  if (mediaPanel) {
    if (media) {
      mediaPanel.hidden = false;
      mediaTitle.textContent = String(media.title || 'Unknown title');
      mediaArtist.textContent = String(media.artist || '');
      mediaPanel.title = media.app ? `Source: ${media.app}` : '';
    } else {
      mediaPanel.hidden = true;
      mediaTitle.textContent = '';
      mediaArtist.textContent = '';
      mediaPanel.title = '';
    }
  }
  if (mediaControls) {
    mediaControls.hidden = !media;
    if (mediaPlayButton) mediaPlayButton.disabled = Boolean(media) && media.canToggle === false;
    if (mediaNextButton) mediaNextButton.disabled = Boolean(media) && media.canNext === false;
    if (mediaPrevButton) mediaPrevButton.disabled = Boolean(media) && media.canPrev === false;
  }
  notch.dataset.mediaPlaying = media && media.playing ? 'true' : 'false';
  // Leaving the feed forgets which cards were rendered so the next open
  // replays the Ref 1 cascade from the top.
  if (status !== 'feed' && feedRenderedIds.size) feedRenderedIds.clear();
  updateChatHeader();
  updateChatComposer();
  if (openChat) renderChatLog();
  if (openFeed) renderFeed();
  let text = '';
  if (state.approval) text = `${state.approval.title}\n\n${state.approval.detail || ''}`;
  else if (state.message) text = state.message;
  else if (status === 'listening') text = 'Speak naturally. Release to send.';
  else if (status === 'done') text = 'Done.';
  else if (status === 'idle') text = 'Ready.';
  if (!openChat && (text !== lastText || lastStatus !== status)) {
    setCardText(text, status === 'answer' && !state.approval);
    lastStatus = status;
  }
  if (interactiveChat && !chatOpenedFor) {
    chatOpenedFor = true;
    api.chat.requestHistory();
  } else if (!interactiveChat) {
    chatOpenedFor = false;
  }
  if (interactiveChat && !wasChatVisible) focusChatInput();
  if (!interactiveChat && wasChatVisible) {
    // Chat closing must NOT go click-through: the pill is still visible, the
    // window shape keeps native input, and main clamps stale interactive
    // requests to a hidden overlay anyway. Old behavior flipped the window to
    // be ignored while it was still on screen, which under a resting cursor
    // left the island dead until the mouse moved again.
    cancelAnimationFrame(chatFocusFrame);
    chatInput.blur();
  }
  wasChatVisible = interactiveChat;
  if (!state.visible) {
    requestInteractive(false);
    hideAckSent = false;
  } else {
    hideAckSent = false;
    if (interactiveChat) requestInteractive(true);
  }
  updateScrollFade();
  retarget();
  sendHitRect();
}

function applyAudioLevel(peak, bins) {
  const normalized = Math.min(1, Math.max(0, Number(peak) || 0) * 9);
  levelTarget = normalized;
  if (Array.isArray(bins)) {
    for (let i = 0; i < BAND_COUNT; i += 1) {
      const value = Number(bins[i]);
      spectrumTarget[i] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : spectrumTarget[i];
    }
  }
  companion?.style.setProperty('--level', normalized.toFixed(3));
  levelMeter.setAttribute('aria-label', `Microphone level ${Math.round(normalized * 100)} percent`);
  if (state.visible && notch.dataset.state === 'listening') startLoop();
}

/* --- Real audio spectrum (Phase C) ---------------------------------------- */
// Compact-listening centerpiece: 16 mic FFT bands painted as a mirrored,
// warm-lit spectrum. Painting runs inside the shared frame loop and only while
// the slot is actually on screen; it decays and clears itself when hidden.
function prepareSpectrum() {
  if (!spectrumCtx) return false;
  if (spectrumUnit) return true;
  const rect = spectrumCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  spectrumCanvas.width = Math.max(2, Math.round(rect.width * dpr));
  spectrumCanvas.height = Math.max(2, Math.round(rect.height * dpr));
  spectrumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spectrumUnit = { w: rect.width, h: rect.height };
  return true;
}

function roundedBar(x, y, width, height, radius) {
  spectrumCtx.beginPath();
  if (typeof spectrumCtx.roundRect === 'function') {
    spectrumCtx.roundRect(x, y, width, height, radius);
  } else {
    spectrumCtx.rect(x, y, width, height);
  }
  spectrumCtx.fill();
}

function paintSpectrum() {
  const { w, h } = spectrumUnit;
  const gap = 2.4;
  const width = barW();
  const step = width + gap;
  const offset = (w - (width * BAND_COUNT + gap * (BAND_COUNT - 1))) / 2;
  const mid = h / 2;
  const grad = spectrumCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(226, 87, 30, .75)');
  grad.addColorStop(0.32, 'rgba(255, 138, 76, .92)');
  grad.addColorStop(0.5, 'rgba(255, 213, 168, 1)');
  grad.addColorStop(0.68, 'rgba(255, 138, 76, .92)');
  grad.addColorStop(1, 'rgba(226, 87, 30, .75)');
  spectrumCtx.clearRect(0, 0, w, h);
  spectrumCtx.fillStyle = grad;
  spectrumCtx.shadowColor = 'rgba(255, 122, 50, .5)';
  spectrumCtx.shadowBlur = 5;
  for (let i = 0; i < BAND_COUNT; i += 1) {
    const value = Math.max(0.06, Math.min(1, spectrumSmooth[i]));
    const reach = value * (mid - 2.5);
    const upH = Math.max(1.8, reach);
    const downH = Math.max(1.2, reach * 0.55);
    const x = offset + i * step;
    roundedBar(x, mid - upH, width, upH, Math.min(width / 2, upH / 2));
    roundedBar(x, mid, width, downH, Math.min(width / 2, downH / 2));
  }
}

function barW() {
  const gap = 2.4;
  return Math.max(2, (spectrumUnit.w - gap * (BAND_COUNT - 1)) / BAND_COUNT);
}

function updateSpectrum(dt) {
  const active = state.visible && notch.dataset.state === 'listening';
  let live = false;
  for (let i = 0; i < BAND_COUNT; i += 1) {
    const target = active ? spectrumTarget[i] : 0;
    const tau = target > spectrumSmooth[i] ? 0.05 : 0.16;
    spectrumSmooth[i] += (target - spectrumSmooth[i]) * (1 - Math.exp(-dt / tau));
    if (spectrumSmooth[i] > 0.012) live = true;
  }
  if (!live) {
    if (spectrumDirty && prepareSpectrum()) {
      spectrumCtx.clearRect(0, 0, spectrumUnit.w, spectrumUnit.h);
      spectrumDirty = false;
    }
    return;
  }
  if (!prepareSpectrum()) return;
  paintSpectrum();
  spectrumDirty = true;
}

/* --- Real speech level (Phase C) ------------------------------------------ */
// TTS playback level modulates the companion squash (--act) and --level while
// the expanded answer is speaking; the pill glow stays CSS-driven.
function applySpeechLevel(payload) {
  const value = Math.max(0, Math.min(1, Number(payload?.level) || 0));
  speechTarget = Math.min(1, value * 2.2);
  if (value > 0.002) speechTrafficAt = Date.now();
  if (state.visible && notch.dataset.state === 'answer' && notch.dataset.speaking === 'true') startLoop();
}

function speakingActive() {
  return state.visible
    && notch.dataset.state === 'answer'
    && notch.dataset.speaking === 'true'
    && Date.now() - speechTrafficAt < 7000;
}

function updateSpeech(dt) {
  if (!companion) return;
  const speaking = speakingActive();
  const target = speaking ? speechTarget : 0;
  speechValue += (target - speechValue) * (1 - Math.exp(-dt / (speaking ? 0.05 : 0.14)));
  if (speaking && speechValue > 0.012) {
    companion.style.setProperty('--act', (1.12 + speechValue * 0.1).toFixed(3));
    companion.style.setProperty('--level', speechValue.toFixed(3));
    companionActMod = true;
  } else if (companionActMod) {
    companion.style.removeProperty('--act');
    companion.style.setProperty('--level', Math.min(1, levelTarget).toFixed(3));
    companionActMod = false;
  }
}

/* --- Stage 2b glow level --------------------------------------------------- */
/* External intensity knob for the orb's iris band. The realtime driver stays
   the --level pipeline (applyAudioLevel for the mic, updateSpeech for TTS);
   this hook only clamps and exposes a multiplier for the settings slider to
   bind later, without touching behavior. */
function setGlowLevel(value) {
  if (!companion) return;
  const level = Number(value);
  if (Number.isFinite(level)) companion.style.setProperty('--blob-glow', Math.max(0, Math.min(1.3, level)).toFixed(2));
  else companion.style.removeProperty('--blob-glow');
}

/* --- Poke / dizzy (blob interaction) ------------------------------------- */
function triggerCompanionPoke() {
  if (!companion || !state.visible || state.companionEnabled === false || reducedMotion()) return;
  if (companionExpression === 'success' || companion.classList.contains('is-dizzy')) return;
  const now = performance.now();
  companionPokeStamps = companionPokeStamps.filter((stamp) => now - stamp < 900);
  companionPokeStamps.push(now);
  if (companionPokeStamps.length >= 5) {
    companionPokeStamps = [];
    companion.classList.remove('is-poked');
    companion.classList.add('is-dizzy');
    resetCompanionLook();
    clearTimeout(companionDizzyTimer);
    companionDizzyTimer = setTimeout(() => {
      companionDizzyTimer = null;
      companion?.classList.remove('is-dizzy');
    }, 2000);
    return;
  }
  companion.classList.remove('is-poked');
  void companion.offsetWidth; // restart the one-shot hop from frame 0
  companion.classList.add('is-poked');
  clearTimeout(companionPokeTimer);
  companionPokeTimer = setTimeout(() => {
    companionPokeTimer = null;
    companion?.classList.remove('is-poked');
  }, 700);
}

stopButton.addEventListener('click', () => {
  api.overlay.stop();
});

chatButton.addEventListener('click', () => {
  api.chat.open();
});

chatCloseButton.addEventListener('click', () => {
  api.chat.close();
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendChatMessage();
});

chatInput.addEventListener('input', () => {
  updateChatComposer();
  if (chatVisible()) retarget();
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  if (chat.streaming || state.chatPreview) return;
  event.preventDefault();
  sendChatMessage();
});

chatStopButton.addEventListener('click', () => {
  chatStopButton.disabled = true;
  api.chat.cancel();
});

copyButton.addEventListener('click', () => {
  api.overlay.copy(cardText.innerText);
  copyButton.textContent = 'Copied';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyButton.textContent = 'Copy';
    copyTimer = null;
  }, 1400);
});

collapseButton.addEventListener('click', () => {
  pinnedTab = null;
  api.overlay.expand('collapsed');
});

notch.addEventListener('click', (event) => {
  if (!state.visible) return;
  if (event.target?.closest('button, input, textarea, a, .card-text')) return;
  if (notch.dataset.state === 'approval') return;
  if (sizeFor(notch.dataset.state) === 'expanded') return;
  api.overlay.expand('pinned');
});

function respond(id, allowed, button) {
  if (!id || respondedApprovalId === id) return;
  respondedApprovalId = id;
  approvalActions.querySelectorAll('button').forEach((element) => {
    element.disabled = true;
  });
  button?.classList.add('is-pressed');
  setTimeout(() => {
    api.overlay.approve(id, allowed);
  }, Math.round(130 * (state.slowMotion ? 4 : 1)));
}

allowButton.addEventListener('click', () => {
  respond(notch.dataset.approvalId, true, allowButton);
});

mediaPlayButton?.addEventListener('click', () => { api.overlay.mediaControl?.('toggle'); });
mediaNextButton?.addEventListener('click', () => { api.overlay.mediaControl?.('next'); });
mediaPrevButton?.addEventListener('click', () => { api.overlay.mediaControl?.('previous'); });

// Phase G: open the live event feed by clicking the resting (idle) pill. The
// head only receives clicks while the pill is hovered (pointer-events rule),
// which matches interactive mode. Real controls keep their own handlers; only
// clicks on the head face itself toggle the feed.
document.querySelector('.pill-head')?.addEventListener('click', (event) => {
  if (event.target.closest('button, #companion, #mediaControls')) return;
  if (!state.visible || notch.dataset.state !== 'idle') return;
  api.overlay.feedToggle?.();
});

/* --- Stage 2 expanded tabs ---------------------------------------------------- */
/* State patches steer the tab automatically; a manual pin only survives while
   the pill rests idle-expanded. Approvals and open chat lock the Assistant tab
   so their controls stay reachable. Clicking a tab on a collapsed pill pins it
   first, exactly like the head-click expansion. */
function setPinnedTab(tab, expandNeeded) {
  if (!TABS.has(tab)) return;
  const status = notch.dataset.state;
  if (status === 'approval') return;
  if (status === 'chat' && state.chatOpen && tab !== 'assistant') return;
  pinnedTab = tab;
  if (expandNeeded) api.overlay.expand('pinned');
  else render();
}

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!state.visible) return;
    if (notch.dataset.size === 'expanded') setPinnedTab(button.dataset.tab, false);
    else setPinnedTab(button.dataset.tab, true);
  });
});

// Round settings button: opens the dashboard settings window. The island pill
// stays as-is — approvals keep their flow, and the dashboard opens on top.
islandSettingsButton?.addEventListener('click', () => {
  if (!state.visible) return;
  try {
    api.overlay.openSettings?.();
  } catch {
    // Blocked-channel guard in preload; never crashes the pill.
  }
});

// Clear all: walks the live stack dismisses every card through the same
// per-item channel main.cjs already normalizes (and forgets) in order.
feedClearButton?.addEventListener('click', () => {
  const items = Array.isArray(state.notifications) ? state.notifications : [];
  for (const item of items) {
    if (!item || !item.id) continue;
    try {
      api.overlay.dismissNotification(String(item.id));
    } catch {
      // Blocked channel guard in preload; the stack re-checks on repaint.
    }
  }
});

// Error state Retry: starts a fresh voice turn (real assistant toggle), so the
// retry is a real action rather than a decorative reset.
retryButton?.addEventListener('click', () => {
  try {
    api.toggleTalk?.();
  } catch {
    // Blocked channel guard in preload; the pill stays in the error state.
  }
});

/* Home preview transport: drives the adapter mock only (no real player), the
   badge stays on until a real source is wired behind the adapter. */
function previewMedia(action) {
  const adapters = window.islandAdapters;
  if (!adapters || typeof adapters.mediaAction !== 'function') return;
  const next = adapters.mediaAction(action);
  notch.dataset.homePlaying = next && next.playing ? 'true' : 'false';
}

homeMediaPlayButton?.addEventListener('click', () => previewMedia('toggle'));
homeMediaPrevButton?.addEventListener('click', () => previewMedia('previous'));
homeMediaNextButton?.addEventListener('click', () => previewMedia('next'));

denyButton.addEventListener('click', () => {
  respond(notch.dataset.approvalId, false, denyButton);
});

document.querySelector('.blob')?.addEventListener('pointerdown', triggerCompanionPoke);

cardText.addEventListener('scroll', updateScrollFade, { passive: true });

document.addEventListener('mousemove', (event) => {
  if (!state.visible) return;
  lastMouse.x = event.clientX;
  lastMouse.y = event.clientY;
  // Shape-based hit testing: the window is input-accepting whenever the pill
  // is visible, so hovering only keeps the CSS hover class and the dismiss
  // timer honest — it never toggles click-through anymore (native mousemove
  // arrives inside the window shape).
  const over = insideNotch(lastMouse.x, lastMouse.y);
  if (over !== notch.classList.contains('is-hovered')) {
    notch.classList.toggle('is-hovered', over);
    if (over) api.overlay.pauseDismiss();
    else api.overlay.resumeDismiss();
  }
  updateCompanionLook(event.clientX, event.clientY);
}, { passive: true });

document.addEventListener('mouseleave', () => {
  resetCompanionLook();
  notch.classList.remove('is-hovered');
  api.overlay.resumeDismiss();
});

window.addEventListener('keydown', (event) => {
  if (state.approval && notch.dataset.state === 'approval') {
    if (event.key === 'Enter') {
      event.preventDefault();
      respond(state.approval.id, true, allowButton);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      respond(state.approval.id, false, denyButton);
    }
    return;
  }
  if (event.key === 'Escape' && chatVisible() && !state.chatPreview) {
    event.preventDefault();
    api.chat.close();
    return;
  }
  if (event.key === 'Escape' && state.expand === 'pinned') {
    event.preventDefault();
    pinnedTab = null;
    api.overlay.expand('collapsed');
  }
});

window.addEventListener('error', (event) => {
  console.error('overlay error', event.error || event.message || 'unknown error');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('overlay unhandled rejection', event.reason || 'unknown rejection');
});
window.addEventListener('pagehide', () => {
  clearCompanionBlink();
  if (companionWakeTimer) { clearTimeout(companionWakeTimer); companionWakeTimer = null; }
  if (companionPokeTimer) { clearTimeout(companionPokeTimer); companionPokeTimer = null; }
  if (companionDizzyTimer) { clearTimeout(companionDizzyTimer); companionDizzyTimer = null; }
  companionPokeStamps = [];
  companion?.classList.remove('is-waking', 'is-poked', 'is-dizzy');
  resetCompanionLook();
});

const resizeObserver = new ResizeObserver(() => {
  updateScrollFade();
  sendHitRect();
  if (!state.visible || !settled()) return;
  retarget();
});
resizeObserver.observe(cardText);
resizeObserver.observe(card);
resizeObserver.observe(head);
resizeObserver.observe(chatInput);
if (feedList) resizeObserver.observe(feedList);
if (islandHome) resizeObserver.observe(islandHome);

// CSS transitions (island morphs animate width/height/scale) end here; the
// settled rect may differ from the last reported one, so re-send the shape.
notch.addEventListener('transitionend', sendHitRect);
window.addEventListener('load', sendHitRect);

motionQuery.addEventListener?.('change', () => {
  document.body.dataset.reducedMotion = reducedMotion() ? 'true' : 'false';
  if (reducedMotion()) resetCompanionLook();
  syncCompanionMotion();
  retarget();
});

api.chat.onStarted(applyChatStarted);
api.chat.onDelta(applyChatDelta);
api.chat.onDone(applyChatDone);
api.chat.onError(applyChatError);
api.chat.onHistory(applyChatHistory);

api.overlay.onState((next) => {
  const appearing = !state.visible && next.visible !== false;
  state = { ...state, ...next, visible: next.visible !== false };
  render();
  if (appearing) {
    for (const spring of [springs.width, springs.height, springs.radius]) {
      spring.value = spring.target;
      spring.velocity = 0;
    }
    springs.scale.value = reducedMotion() ? 1 : 0.85;
    springs.scale.velocity = 0;
    springs.opacity.value = 0;
    springs.opacity.velocity = 0;
    springs.blur.value = reducedMotion() ? 0 : 6;
    springs.blur.velocity = 0;
    applyGeometry();
    startLoop();
  }
});

api.overlay.onAudioLevel(({ peak, bins }) => applyAudioLevel(peak, bins));
api.overlay.onSpeechLevel?.((payload) => applySpeechLevel(payload));
api.overlay.onCursor?.((coords) => {
  if (!coords || !state.visible) return;
  const x = Number(coords.x) || 0;
  const y = Number(coords.y) || 0;
  updateCompanionLook(x, y);
  // Under shape-based hit testing the DOM receives mousemove only inside the
  // window region; main's cursor feed is the honest signal for the rest of
  // the window, so it also keeps the hover class and dismiss pause truthful.
  const over = insideNotch(x, y);
  if (over !== notch.classList.contains('is-hovered')) {
    notch.classList.toggle('is-hovered', over);
    if (over) api.overlay.pauseDismiss();
    else api.overlay.resumeDismiss();
  }
});

document.fonts?.ready?.then(() => retarget()).catch(() => {});

/* Stage 2b Lite mode: static gradients, no blur layers, no morph. Auto-selected
   on low-power hardware (<= 4 threads) or when prefers-reduced-motion is on;
   the reduced-motion media block in island.css already statics the orb there —
   the class keeps the same look consistent for the hardware-tier path. */
(() => {
  const cores = navigator.hardwareConcurrency || 8;
  if (reducedMotion() || cores <= 4) companion?.classList.add('is-lite');
})();
applyGeometry();
render();
// First-shape kick: paints for the very first state (load lands visible=false,
// so the rAF guard keeps it quiet until the first real show).
sendHitRect();
