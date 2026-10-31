'use strict';

const { VOICE_COMMAND_MODE_IDS } = require('./constants.cjs');

function normalizeVoiceCommandMode(value, fallback = 'smart') {
  if (typeof value === 'string' && VOICE_COMMAND_MODE_IDS.has(value)) return value;
  return VOICE_COMMAND_MODE_IDS.has(fallback) ? fallback : 'smart';
}

// Smart mode must be conservative: a plain question should never start the
// desktop driver, while an imperative request should. These patterns are
// intentionally deterministic so the routing decision is testable without a
// model call.
const QUESTION_START = /^(?:what|what's|whats|why|how|who|whom|whose|when|where|which|is|are|was|were|do|does|did|can|could|would|should|will|may|might|shall|have|has|had|tell me|explain|define|describe|summari[sz]e|give me)\b/i;
const REQUEST_START = /^(?:can|could|would|will|please|kindly|i want you to|i need you to|i'd like you to|go ahead and|help me|let's|lets)\b/i;
const ACTION_VERB = /\b(?:open|launch|start|run|close|quit|exit|kill|force[- ]?close|type|enter|fill|click|double[- ]?click|right[- ]?click|press|hit|select|scroll|drag|drop|save|save as|delete|remove|rename|copy|paste|move|minimize|maximize|restore|switch|focus|bring|navigate|go to|search|download|install|uninstall|set|change|turn (?:on|off)|enable|disable|toggle|send|create|make|add|put|insert|edit|resize|snap|check|uncheck|play|pause|skip|mute|unmute|lock|sign in|log in|open up|pull up)\b/i;
const SCREEN_TASK = /\b(?:what(?:'s| is)? (?:on my|on the) screen|what(?:'s| is)? open|what windows are open|read (?:this|the) (?:window|screen)|describe (?:this|the) (?:screen|window)|look at (?:my|the) screen)\b/i;
const WRITE_TO_APP = /\bwrite\b[\s\S]*\b(?:in|into|to)\b[\s\S]*\b(?:app|application|window|document|file|notepad|word|excel|browser|chat)\b/i;

function classifyVoiceCommand(transcript) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'question', task: false, reason: 'empty' };
  if (SCREEN_TASK.test(text)) {
    return { kind: 'task', task: true, reason: 'screen-inspection request' };
  }
  if (REQUEST_START.test(text) && ACTION_VERB.test(text)) {
    return { kind: 'task', task: true, reason: 'polite action request' };
  }
  if (QUESTION_START.test(text)) {
    return { kind: 'question', task: false, reason: 'question opener' };
  }
  if (ACTION_VERB.test(text)) {
    return { kind: 'task', task: true, reason: 'action verb' };
  }
  if (WRITE_TO_APP.test(text)) {
    return { kind: 'task', task: true, reason: 'write into an app' };
  }
  return { kind: 'question', task: false, reason: 'no action verb' };
}

const NEGATIVE_START = /^(?:no|nope|nah|negative|don't|do not|not now|cancel|stop|never|deny|decline|abort)\b/i;
const AFFIRMATIVE_START = /^(?:yes|yeah|yep|yup|sure|okay|ok|affirmative|confirm|confirmed|go ahead|do it|please do|that's right|correct|absolutely|of course)\b/i;
const NEGATIVE_WORD = /\b(?:no|nope|nah|negative|cancel|stop|never|deny|decline|abort)\b/i;
const AFFIRMATIVE_WORD = /\b(?:yes|yeah|yep|yup|sure|okay|ok|affirmative|confirm|confirmed)\b/i;

function parseVoiceConfirmation(transcript) {
  const text = String(transcript || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (NEGATIVE_START.test(text)) return false;
  if (AFFIRMATIVE_START.test(text)) return true;
  const negative = NEGATIVE_WORD.test(text);
  const affirmative = AFFIRMATIVE_WORD.test(text);
  if (negative && !affirmative) return false;
  if (affirmative && !negative) return true;
  return null;
}

module.exports = {
  normalizeVoiceCommandMode,
  classifyVoiceCommand,
  parseVoiceConfirmation
};
