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
const companion = $('#companion');
const waveBars = [...(levelMeter?.querySelectorAll('i') || [])];
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const MAX_CARD_HEIGHT = 400;
const MAX_ANIMATED_WORDS = 280;
const ISLAND_SIZES = {
  compact: { width: 150, height: 36 },
  medium: { width: 300, height: 56 },
  expanded: { width: 420 }
};
const NOTCH_WIDTH = 440;
const MEDIUM_STATES = new Set(['thinking', 'executing', 'verifying', 'done']);
const EXPANDED_STATES = new Set(['answer', 'approval', 'error', 'chat']);
const SUPPORTED_STATES = new Set(['idle', 'listening', ...MEDIUM_STATES, ...EXPANDED_STATES]);
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
  chatOpen: false,
  chatStreaming: false,
  chatPreview: false
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
let hideAckSent = false;
let raf = 0;
let lastFrame = 0;
let levelTarget = 0;
let level = 0;
let wavePhase = 0;
let chatOpenedFor = false;
let wasChatVisible = false;
let chatFocusFrame = 0;
let chatRenderFrame = 0;
let companionBlinkTimer = null;
let companionBlinkOffTimer = null;
let companionExpression = 'idle';

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

function resetCompanionLook() {
  if (!companion) return;
  companion.style.setProperty('--look-x', '0px');
  companion.style.setProperty('--look-y', '0px');
}

function updateCompanionLook(clientX, clientY) {
  if (!companion || !state.visible || state.companionEnabled === false || reducedMotion()) return;
  if (companion.dataset.expression === 'success') return;
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
  if (!companion || !state.visible || state.companionEnabled === false || reducedMotion() || companionExpression === 'success') return;
  if (companionBlinkTimer || companionBlinkOffTimer) return;
  const slow = state.slowMotion ? 4 : 1;
  companionBlinkTimer = setTimeout(() => {
    companionBlinkTimer = null;
    if (!companion || !state.visible || state.companionEnabled === false || reducedMotion() || companionExpression === 'success') return;
    companion.classList.add('is-blinking');
    companionBlinkOffTimer = setTimeout(() => {
      companionBlinkOffTimer = null;
      companion?.classList.remove('is-blinking');
      scheduleCompanionBlink();
    }, Math.round(130 * slow));
  }, Math.round((2800 + Math.random() * 3000) * slow));
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
  chatButton.hidden = !state.visible || open || preview || voiceBusy();
  chatCloseButton.hidden = !state.visible || !open || preview;
  stopButton.hidden = open;
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
    chat: state.chatPreview ? 'Chat preview' : chat.streaming ? 'Replying…' : 'Ask Voxa'
  };
  return mapping[status] || status;
}

function sizeFor(status) {
  if (EXPANDED_STATES.has(status)) return 'expanded';
  if (MEDIUM_STATES.has(status)) return 'medium';
  return 'compact';
}

function contentWidthFor(size) {
  if (state.style === 'notch') return NOTCH_WIDTH;
  return size === 'expanded' ? ISLAND_SIZES.expanded.width : ISLAND_SIZES[size].width;
}

function measureCard(contentWidth) {
  const clone = card.cloneNode(true);
  clone.removeAttribute('id');
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

function targetGeometry() {
  const status = notch.dataset.state;
  const size = sizeFor(status);
  const expanded = size === 'expanded';
  const chatMode = status === 'chat' && Boolean(state.chatOpen);
  const contentWidth = contentWidthFor(size);
  notch.style.setProperty('--content-width', `${contentWidth}px`);
  const cardHeight = expanded && !chatMode ? Math.min(MAX_CARD_HEIGHT, measureCard(contentWidth)) : 0;
  const chatHeight = chatMode ? Math.min(MAX_CARD_HEIGHT, measureChat(contentWidth)) : 0;
  let width;
  let height;
  let radius;
  if (state.style === 'notch') {
    width = NOTCH_WIDTH;
    height = chatMode
      ? Math.max(150, Math.round((head.offsetHeight || 48) + chatHeight + 2))
      : expanded
        ? Math.max(86, Math.round((head.offsetHeight || 48) + cardHeight + 2))
        : size === 'medium' ? 60 : 48;
    radius = 22;
  } else {
    width = contentWidth;
    height = chatMode
      ? Math.max(150, Math.min(MAX_CARD_HEIGHT, Math.round((head.offsetHeight || 48) + chatHeight + 2)))
      : expanded
        ? Math.max(84, Math.round((head.offsetHeight || 48) + cardHeight + 2))
        : ISLAND_SIZES[size].height;
    radius = expanded ? 28 : size === 'medium' ? 24 : height / 2;
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
  width: new Spring(ISLAND_SIZES.compact.width),
  height: new Spring(ISLAND_SIZES.compact.height),
  radius: new Spring(ISLAND_SIZES.compact.height / 2),
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

function updateScrollFade() {
  const max = cardText.scrollHeight - cardText.clientHeight;
  const scrolled = cardText.scrollTop > 4;
  const moreBelow = max > 8 && cardText.scrollTop < max - 4;
  notch.dataset.scrolled = scrolled ? 'true' : 'false';
  notch.dataset.moreBelow = moreBelow ? 'true' : 'false';
  card.dataset.scrolled = scrolled ? 'true' : 'false';
}

function render() {
  const status = SUPPORTED_STATES.has(state.status) ? state.status : 'thinking';
  const size = sizeFor(status);
  const style = state.style === 'notch' ? 'notch' : 'island';
  const openChat = status === 'chat' && state.chatOpen;
  const interactiveChat = openChat && !state.chatPreview;
  notch.dataset.state = status;
  notch.dataset.size = size;
  notch.dataset.style = style;
  notch.dataset.visible = state.visible ? 'true' : 'false';
  notch.dataset.mode = state.mode || 'agent';
  notch.dataset.scrolled = cardText.scrollTop > 4 ? 'true' : 'false';
  stage.dataset.style = style;
  updateCompanion(status);
  document.body.classList.toggle('slow-motion', Boolean(state.slowMotion));
  document.body.dataset.reducedMotion = reducedMotion() ? 'true' : 'false';
  setLabel(statusLabel(status));
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
  card.hidden = openChat;
  chatPanel.hidden = !openChat;
  updateChatHeader();
  updateChatComposer();
  if (openChat) renderChatLog();
  let text = '';
  if (state.approval) text = `${state.approval.title}\n\n${state.approval.detail || ''}`;
  else if (state.message) text = state.message;
  else if (status === 'listening') text = 'Speak naturally. Release to send.';
  else if (status === 'done') text = 'Done.';
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
    cancelAnimationFrame(chatFocusFrame);
    chatInput.blur();
    requestInteractive(false);
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
}

function applyAudioLevel(peak) {
  const normalized = Math.min(1, Math.max(0, Number(peak) || 0) * 9);
  levelTarget = normalized;
  levelMeter.setAttribute('aria-label', `Microphone level ${Math.round(normalized * 100)} percent`);
  if (state.visible && notch.dataset.state === 'listening') startLoop();
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

denyButton.addEventListener('click', () => {
  respond(notch.dataset.approvalId, false, denyButton);
});

cardText.addEventListener('scroll', updateScrollFade, { passive: true });

document.addEventListener('mousemove', (event) => {
  if (!state.visible) return;
  const rect = notch.getBoundingClientRect();
  const padding = 5;
  const over = event.clientX >= rect.left - padding
    && event.clientX <= rect.right + padding
    && event.clientY >= rect.top - padding
    && event.clientY <= rect.bottom + padding;
  if (over !== interactive) {
    requestInteractive(over);
    notch.classList.toggle('is-hovered', over);
    if (over) api.overlay.pauseDismiss();
    else api.overlay.resumeDismiss();
  }
  updateCompanionLook(event.clientX, event.clientY);
}, { passive: true });

document.addEventListener('mouseleave', () => {
  resetCompanionLook();
  if (!interactive) return;
  requestInteractive(false);
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
  resetCompanionLook();
});

const resizeObserver = new ResizeObserver(() => {
  updateScrollFade();
  if (!state.visible || !settled()) return;
  retarget();
});
resizeObserver.observe(cardText);
resizeObserver.observe(card);
resizeObserver.observe(head);
resizeObserver.observe(chatInput);

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

api.overlay.onAudioLevel(({ peak }) => applyAudioLevel(peak));

document.fonts?.ready?.then(() => retarget()).catch(() => {});
applyGeometry();
render();
