'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BUFFER = 500;
const MAX_DETAIL = 4000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let logFile = null;
let subscribers = new Set();
let buffer = [];
// Bumped whenever the on-disk log is replaced or truncated. Page cursors carry
// this token so a rotation cannot make an old index point into the new file.
let logGeneration = 0;

function toText(value) {
  if (value instanceof Error) return `${value.message || value.name || 'Error'}${value.stack ? `\n${value.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redact(value) {
  return String(value ?? '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\bgsk_[A-Za-z0-9]{8,}\b/g, '[redacted-key]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]')
    .replace(/\b(api[_-]?key|access[_-]?token|oauth[_-]?token|auth[_-]?token|password|secret)(\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi, '$1$2[redacted]');
}

function clean(value) {
  return redact(toText(value)).replace(/\u0000/g, '').slice(0, MAX_DETAIL);
}

function setLogFile(filePath) {
  logFile = filePath ? path.resolve(filePath) : null;
  logGeneration += 1;
  if (!logFile) return null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (error) {
    console.error(`[logger] Could not create log directory ${path.dirname(logFile)}: ${error.message}`);
    logFile = null;
  }
  return logFile;
}

function getLogFile() {
  return logFile;
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function rotateIfNeeded() {
  if (!logFile) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size <= MAX_FILE_BYTES) return;
    const previous = `${logFile}.1`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(logFile, previous);
    logGeneration += 1;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[logger] Could not rotate ${logFile}: ${error.message}`);
  }
}

function append(entry) {
  if (!logFile) return false;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error(`[logger] Could not append ${logFile}: ${error.message}`);
    return false;
  }
}

function write(level, step, detail = '') {
  const entry = {
    time: new Date().toISOString(),
    level,
    step: clean(step || 'event').split('\n')[0].slice(0, 120),
    detail: clean(detail)
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  for (const listener of subscribers) {
    try {
      listener(entry);
    } catch (error) {
      console.error(`[logger] Log subscriber failed: ${error.message}`);
    }
  }
  append(entry);
  const line = `${entry.time} [${entry.level}] [${entry.step}]${entry.detail ? ` ${entry.detail}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

function info(step, detail) {
  return write('info', step, detail);
}

function warn(step, detail) {
  return write('warn', step, detail);
}

function error(step, detail) {
  return write('error', step, detail);
}

// Truncate the on-disk log and drop the in-memory tail. Returns false when the
// file exists but could not be cleared, so the caller can report a partial wipe.
function clear() {
  buffer = [];
  if (!logFile) return true;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '', 'utf8');
    fs.rmSync(`${logFile}.1`, { force: true });
    logGeneration += 1;
    return true;
  } catch (error) {
    console.error(`[logger] Could not clear ${logFile}: ${error.message}`);
    return false;
  }
}

// Raw lines only: JSON parsing is deferred so a 500-line page does not pay for
// every line in the file.
function readLines() {
  if (logFile) {
    try {
      const text = fs.readFileSync(logFile, 'utf8');
      return text
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        .filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[logger] Could not read ${logFile}: ${error.message}`);
    }
  }
  return buffer.map(formatEntry);
}

function parseLine(line) {
  try {
    const entry = JSON.parse(line);
    if (entry && typeof entry === 'object') return formatEntry(entry);
  } catch {
    // Keep plain-text lines readable alongside JSON entries.
  }
  return line;
}

// `before` is an opaque cursor of the form "<generation>:<index>" naming the
// oldest line already loaded. The log is append-only, so older indexes stay
// valid while new lines arrive; the generation token rejects cursors from a
// file that was rotated or cleared since the page was read.
function readPage(limit = 500, before = '') {
  const size = Math.max(1, Math.min(Number(limit) || 500, 5000));
  const rows = readLines();
  const total = rows.length;
  const stale = { lines: [], nextBefore: '', hasMore: false, total, stale: true };

  let index = NaN;
  if (before !== '' && before != null) {
    const text = String(before);
    const separator = text.lastIndexOf(':');
    if (separator > 0) {
      const generation = Number(text.slice(0, separator));
      index = Number(text.slice(separator + 1));
      if (Number.isFinite(generation) && generation !== logGeneration) return stale;
    } else {
      // Cursors written before generation tokens existed.
      index = Number(text);
    }
  }

  if (Number.isFinite(index) && index > total) return stale;
  const end = Number.isFinite(index) && index >= 0 ? Math.floor(index) : total;
  const start = Math.max(0, end - size);
  return {
    lines: rows.slice(start, end).map(parseLine),
    nextBefore: start > 0 ? `${logGeneration}:${start}` : '',
    hasMore: start > 0,
    total
  };
}

function read(limit = 500) {
  return readPage(limit).lines;
}

function formatEntry(entry) {
  return `${entry.time} [${entry.level || 'info'}] [${entry.step}]${entry.detail ? ` ${entry.detail}` : ''}`;
}

function entries(limit = 500) {
  return buffer.slice(-limit);
}

module.exports = {
  setLogFile,
  getLogFile,
  subscribe,
  info,
  warn,
  error,
  clear,
  read,
  readPage,
  entries,
  formatEntry,
  redact,
  cleanDetail: clean
};
