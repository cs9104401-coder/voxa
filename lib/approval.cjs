'use strict';

const DEFAULT_TIMEOUT_MS = 120000;

function createApprovalGate(options = {}) {
  const configured = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
  let pending = null;

  function settle(entry, allowed) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (pending === entry) pending = null;
    entry.resolve(Boolean(allowed));
    return true;
  }

  return {
    request(id, turnId) {
      const entry = { id, turnId, settled: false, resolve: null, timer: null };
      const decision = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      if (pending) settle(pending, false);
      pending = entry;
      entry.timer = setTimeout(() => {
        if (pending !== entry || entry.settled) return;
        settle(entry, false);
        try {
          options.onTimeout?.({ id: entry.id, turnId: entry.turnId });
        } catch {
          // The timeout callback is best-effort; the denial still stands.
        }
      }, timeoutMs);
      entry.timer.unref?.();
      return decision;
    },
    respond(id, allowed) {
      if (!pending) return false;
      if (id && pending.id !== id) return false;
      return settle(pending, allowed);
    },
    cancelTurn(turnId) {
      if (!pending || pending.turnId !== turnId) return false;
      return settle(pending, false);
    },
    cancelAll() {
      if (!pending) return false;
      return settle(pending, false);
    },
    current() {
      return pending ? { id: pending.id, turnId: pending.turnId } : null;
    },
    timeoutMs
  };
}

module.exports = { createApprovalGate, DEFAULT_TIMEOUT_MS };
