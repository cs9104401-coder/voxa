'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BUFFER = 500;
const MAX_DETAIL = 4000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let logFile = null;
let subscribers = new Set();
let buffer = [];

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
    return true;
  } catch (error) {
    console.error(`[logger] Could not clear ${logFile}: ${error.message}`);
    return false;
  }
}

function read(limit = 500) {
  if (logFile) {
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
      return lines.map((line) => {
        try {
          const entry = JSON.parse(line);
          return entry && typeof entry === 'object' ? formatEntry(entry) : line;
        } catch {
          return line;
        }
      });
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[logger] Could not read ${logFile}: ${error.message}`);
    }
  }
  return buffer.slice(-limit).map(formatEntry);
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
  entries,
  formatEntry,
  redact,
  cleanDetail: clean
};
