'use strict';

const api = window.voiceAgent;
const $ = (selector) => document.querySelector(selector);
const notch = $('#notch');
const card = $('#notchCard');
const cardText = $('#cardText');
const stateLabel = $('#notchState');
const approvalActions = $('#approvalActions');
const copyButton = $('#copyButton');
let state = { visible: false, status: 'idle', mode: 'agent', message: '', approval: null, canCopy: false };
let reportFrame = 0;
let lastReportedHeight = 0;
let copyTimer = null;
let respondedApprovalId = '';

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

function applyShape(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  if (w < 2 || h < 2) return;
  const outerLeft = Math.round(w / 2 - 66);
  const innerLeft = Math.round(w / 2 - 22);
  const innerRight = Math.round(w / 2 + 22);
  const outerRight = Math.round(w / 2 + 66);
  const radius = Math.min(18, Math.floor(h / 4));
  const path = [
    'M0 0',
    `H${outerLeft}`,
    `C${outerLeft + 12} 0 ${outerLeft + 14} 14 ${innerLeft - 20} 20`,
    `Q${innerLeft - 10} 26 ${innerLeft} 26`,
    `H${innerRight}`,
    `Q${innerRight + 10} 26 ${innerRight + 20} 20`,
    `C${outerRight - 14} 14 ${outerRight - 12} 0 ${outerRight} 0`,
    `H${w}`,
    `V${h - radius}`,
    `Q${w} ${h} ${w - radius} ${h}`,
    `H${radius}`,
    `Q0 ${h} 0 ${h - radius}`,
    'Z'
  ].join(' ');
  notch.style.clipPath = `path("${path}")`;
  notch.style.webkitClipPath = `path("${path}")`;
}

function reportSize() {
  cancelAnimationFrame(reportFrame);
  reportFrame = requestAnimationFrame(() => {
    const rect = notch.getBoundingClientRect();
    applyShape(rect.width, rect.height);
    const visibleHeight = Math.max(96, Math.min(520, Math.ceil(rect.height)));
    if (Math.abs(visibleHeight - lastReportedHeight) < 2) return;
    lastReportedHeight = visibleHeight;
    api.overlay.resize(460, visibleHeight);
  });
}

function setText(text) {
  cardText.replaceChildren(markdown(text));
  card.scrollTop = 0;
  reportSize();
}

function render() {
  const mapping = {
    idle: 'Idle',
    listening: 'Listening',
    thinking: 'Thinking',
    executing: 'Executing',
    verifying: 'Verifying',
    answer: api.appName + ' replied',
    approval: 'Approval needed',
    error: 'Needs attention'
  };
  const supported = ['idle', 'listening', 'thinking', 'executing', 'verifying', 'answer', 'approval', 'error'];
  const status = supported.includes(state.status) ? state.status : 'thinking';
  notch.dataset.state = status;
  notch.dataset.visible = state.visible ? 'true' : 'false';
  notch.dataset.mode = state.mode || 'agent';
  stateLabel.textContent = mapping[status] || status;
  const approvalId = state.approval?.id || '';
  if (approvalId !== respondedApprovalId) respondedApprovalId = '';
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
  if (state.approval) {
    setText(`${state.approval.title}\n\n${state.approval.detail || ''}`);
    notch.dataset.approvalId = state.approval.id;
  } else {
    notch.dataset.approvalId = '';
    setText(state.message || (status === 'listening' ? 'Speak naturally. Release to send.' : ''));
  }
  reportSize();
}

function applyAudioLevel(peak) {
  const normalized = Math.min(1, Math.max(0, Number(peak) || 0) * 9);
  notch.style.setProperty('--level', String(normalized));
  const meter = $('#levelMeter');
  if (meter) meter.setAttribute('aria-label', `Microphone level ${Math.round(normalized * 100)} percent`);
}

$('#stopButton').addEventListener('click', () => {
  api.overlay.stop();
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

function respond(id, allowed) {
  if (!id || respondedApprovalId === id) return;
  respondedApprovalId = id;
  approvalActions.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  api.overlay.approve(id, allowed);
}

$('#allowButton').addEventListener('click', () => {
  respond(notch.dataset.approvalId, true);
});

$('#denyButton').addEventListener('click', () => {
  respond(notch.dataset.approvalId, false);
});

window.addEventListener('keydown', (event) => {
  if (!state.approval || notch.dataset.state !== 'approval') return;
  if (event.key === 'Enter') {
    event.preventDefault();
    respond(state.approval.id, true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    respond(state.approval.id, false);
  }
});

window.addEventListener('error', (event) => {
  console.error('overlay error', event.error || event.message || 'unknown error');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('overlay unhandled rejection', event.reason || 'unknown rejection');
});

api.overlay.onState((next) => {
  state = { ...state, ...next, visible: next.visible !== false };
  render();
});

api.overlay.onAudioLevel(({ peak }) => applyAudioLevel(peak));

new ResizeObserver(reportSize).observe(notch);
render();
requestAnimationFrame(() => {
  api.overlay.resize(460, Math.max(96, Math.ceil(notch.getBoundingClientRect().height)));
});
