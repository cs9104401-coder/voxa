'use strict';

// Pure text normaliser and sentence segmenter for TTS.
// No Electron imports — unit-testable offline.
// Log only text lengths, never spoken content.

// ─── Abbreviations that must not trigger a sentence break ────────────────────
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'ft', 'vs', 'etc',
  'inc', 'ltd', 'co', 'corp', 'llc', 'no', 'vol', 'fig', 'pp', 'al',
  'approx', 'avg', 'bldg', 'dept', 'est', 'govt', 'mt', 'pvt', 'rte', 'sq',
  'ste', 'univ', 'tel', 'ext', 'alt', 'attn', 'phd', 'md', 'dvm', 'esq',
  'hon', 'rep', 'sen', 'gen', 'adm', 'cmdr', 'capt', 'sgt', 'cpl', 'lt',
  'rev', 'arch', 'att', 'asst', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'wed', 'thu',
  'fri', 'sat', 'sun', 'e.g', 'i.e'
]);

// ─── Kokoro voice table (from hexgrad/Kokoro-82M VOICES.md and onnx-community repo) ─
// lang_code: a=American English, b=British English, e=Spanish, f=French,
//            h=Hindi, i=Italian, j=Japanese, p=Brazilian Portuguese, z=Mandarin
const VOICES = [
  // American English
  { id: 'af_heart',    lang: 'a', gender: 'f', label: 'Heart (American English)' },
  { id: 'af_alloy',    lang: 'a', gender: 'f', label: 'Alloy (American English)' },
  { id: 'af_aoede',    lang: 'a', gender: 'f', label: 'Aoede (American English)' },
  { id: 'af_bella',    lang: 'a', gender: 'f', label: 'Bella (American English)' },
  { id: 'af_jessica',  lang: 'a', gender: 'f', label: 'Jessica (American English)' },
  { id: 'af_kore',     lang: 'a', gender: 'f', label: 'Kore (American English)' },
  { id: 'af_nicole',   lang: 'a', gender: 'f', label: 'Nicole (American English)' },
  { id: 'af_nova',     lang: 'a', gender: 'f', label: 'Nova (American English)' },
  { id: 'af_river',    lang: 'a', gender: 'f', label: 'River (American English)' },
  { id: 'af_sarah',    lang: 'a', gender: 'f', label: 'Sarah (American English)' },
  { id: 'af_sky',      lang: 'a', gender: 'f', label: 'Sky (American English)' },
  { id: 'am_adam',     lang: 'a', gender: 'm', label: 'Adam (American English)' },
  { id: 'am_echo',     lang: 'a', gender: 'm', label: 'Echo (American English)' },
  { id: 'am_eric',     lang: 'a', gender: 'm', label: 'Eric (American English)' },
  { id: 'am_fenrir',   lang: 'a', gender: 'm', label: 'Fenrir (American English)' },
  { id: 'am_liam',     lang: 'a', gender: 'm', label: 'Liam (American English)' },
  { id: 'am_michael',  lang: 'a', gender: 'm', label: 'Michael (American English)' },
  { id: 'am_onyx',     lang: 'a', gender: 'm', label: 'Onyx (American English)' },
  { id: 'am_puck',     lang: 'a', gender: 'm', label: 'Puck (American English)' },
  { id: 'am_santa',    lang: 'a', gender: 'm', label: 'Santa (American English)' },
  // British English
  { id: 'bf_alice',    lang: 'b', gender: 'f', label: 'Alice (British English)' },
  { id: 'bf_emma',     lang: 'b', gender: 'f', label: 'Emma (British English)' },
  { id: 'bf_isabella', lang: 'b', gender: 'f', label: 'Isabella (British English)' },
  { id: 'bf_lily',     lang: 'b', gender: 'f', label: 'Lily (British English)' },
  { id: 'bm_daniel',   lang: 'b', gender: 'm', label: 'Daniel (British English)' },
  { id: 'bm_fable',    lang: 'b', gender: 'm', label: 'Fable (British English)' },
  { id: 'bm_george',   lang: 'b', gender: 'm', label: 'George (British English)' },
  { id: 'bm_lewis',    lang: 'b', gender: 'm', label: 'Lewis (British English)' },
  // Spanish
  { id: 'ef_dora',     lang: 'e', gender: 'f', label: 'Dora (Spanish)' },
  { id: 'em_alex',     lang: 'e', gender: 'm', label: 'Alex (Spanish)' },
  { id: 'em_santa',    lang: 'e', gender: 'm', label: 'Santa (Spanish)' },
  // French
  { id: 'ff_siwis',    lang: 'f', gender: 'f', label: 'Siwis (French)' },
  // Hindi
  { id: 'hf_alpha',    lang: 'h', gender: 'f', label: 'Alpha (Hindi)' },
  { id: 'hf_beta',     lang: 'h', gender: 'f', label: 'Beta (Hindi)' },
  { id: 'hm_omega',    lang: 'h', gender: 'm', label: 'Omega (Hindi)' },
  { id: 'hm_psi',      lang: 'h', gender: 'm', label: 'Psi (Hindi)' },
  // Italian
  { id: 'if_sara',     lang: 'i', gender: 'f', label: 'Sara (Italian)' },
  { id: 'im_nicola',   lang: 'i', gender: 'm', label: 'Nicola (Italian)' },
  // Japanese
  { id: 'jf_alpha',      lang: 'j', gender: 'f', label: 'Alpha (Japanese)' },
  { id: 'jf_gongitsune', lang: 'j', gender: 'f', label: 'Gongitsune (Japanese)' },
  { id: 'jf_nezumi',     lang: 'j', gender: 'f', label: 'Nezumi (Japanese)' },
  { id: 'jf_tebukuro',   lang: 'j', gender: 'f', label: 'Tebukuro (Japanese)' },
  { id: 'jm_kumo',       lang: 'j', gender: 'm', label: 'Kumo (Japanese)' },
  // Brazilian Portuguese
  { id: 'pf_dora',     lang: 'p', gender: 'f', label: 'Dora (Portuguese)' },
  { id: 'pm_alex',     lang: 'p', gender: 'm', label: 'Alex (Portuguese)' },
  { id: 'pm_santa',    lang: 'p', gender: 'm', label: 'Santa (Portuguese)' },
  // Mandarin Chinese
  { id: 'zf_xiaobei',  lang: 'z', gender: 'f', label: 'Xiaobei (Mandarin)' },
  { id: 'zf_xiaoni',   lang: 'z', gender: 'f', label: 'Xiaoni (Mandarin)' },
  { id: 'zf_xiaoxiao', lang: 'z', gender: 'f', label: 'Xiaoxiao (Mandarin)' },
  { id: 'zf_xiaoyi',   lang: 'z', gender: 'f', label: 'Xiaoyi (Mandarin)' },
  { id: 'zm_yunjian',  lang: 'z', gender: 'm', label: 'Yunjian (Mandarin)' },
  { id: 'zm_yunxi',    lang: 'z', gender: 'm', label: 'Yunxi (Mandarin)' },
  { id: 'zm_yunxia',   lang: 'z', gender: 'm', label: 'Yunxia (Mandarin)' },
  { id: 'zm_yunyang',  lang: 'z', gender: 'm', label: 'Yunyang (Mandarin)' }
];

/** Return the first voice for a given lang_code, or null. */
function findVoiceForLang(langCode) {
  return VOICES.find((v) => v.lang === langCode) || null;
}

/** Return all voices as a flat array. */
function allVoices() {
  return VOICES.slice();
}

// ─── Number-to-words helpers ──────────────────────────────────────────────────
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function underOneThousand(n) {
  const words = [];
  const h = Math.floor(n / 100);
  if (h) words.push(ONES[h], 'hundred');
  const r = n % 100;
  if (r >= 20) {
    words.push(TENS[Math.floor(r / 10)]);
    const o = r % 10;
    if (o) words.push(ONES[o]);
  } else if (r > 0) {
    words.push(ONES[r]);
  }
  return words;
}

function intToWords(n) {
  if (n === 0) return ['zero'];
  if (n < 0) return ['minus', ...intToWords(-n)];
  const words = [];
  const scales = [
    [1_000_000_000_000, 'trillion'],
    [1_000_000_000, 'billion'],
    [10_000_000, 'crore'],
    [100_000, 'lakh'],
    [1_000, 'thousand'],
    [100, 'hundred']
  ];
  let rem = n;
  for (const [scale, label] of scales) {
    if (rem >= scale) {
      words.push(...intToWords(Math.floor(rem / scale)), label);
      rem %= scale;
    }
  }
  if (rem > 0) words.push(...underOneThousand(rem));
  return words;
}

function numericStringToWords(raw) {
  // Strip commas, convert decimals.
  const clean = raw.replace(/,/g, '');
  const dot = clean.indexOf('.');
  if (dot === -1) {
    const n = parseInt(clean, 10);
    if (!Number.isFinite(n) || String(n).length > 13) return raw;
    return intToWords(n).join(' ');
  }
  const whole = parseInt(clean.slice(0, dot), 10);
  const frac = clean.slice(dot + 1).slice(0, 4);
  const left = Number.isFinite(whole) ? intToWords(whole).join(' ') : '';
  const right = frac ? `point ${frac.split('').map((d) => ONES[Number(d)]).join(' ')}` : '';
  return [left, right].filter(Boolean).join(' ');
}

// ─── Text normaliser ──────────────────────────────────────────────────────────

/**
 * Normalise text for TTS:
 * - Strip markdown (headings, emphasis, bullets, code, tables, HR, blockquotes)
 * - Replace fenced code blocks with "code block"
 * - Replace links with domain only
 * - Remove emoji
 * - Speak out numbers, currency (₹/$), percentages, dates, abbreviations
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseForSpeech(text) {
  if (typeof text !== 'string') return '';
  let out = text;

  // Fenced code blocks → "code block"
  out = out.replace(/```[\s\S]*?```/g, ' code block ');
  // Inline code → unwrap
  out = out.replace(/`([^`]*)`/g, '$1');

  // Markdown images → alt text
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Markdown links → domain only
  out = out.replace(/\[([^\]]*)\]\((https?:\/\/[^)]*)\)/g, (_m, _label, url) => {
    try { return new URL(url).hostname; } catch { return _label || url; }
  });
  // Remaining markdown links → label
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Bare URLs → domain only
  out = out.replace(/\bhttps?:\/\/([^\s<>"')]+)/g, (_m, rest) => {
    const slash = rest.indexOf('/');
    return slash < 0 ? rest : rest.slice(0, slash);
  });

  // Markdown headings
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  // Bold/italic emphasis
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2');
  out = out.replace(/(\*|_)(.+?)\1/g, '$2');
  // Strikethrough
  out = out.replace(/~~(.+?)~~/g, '$1');
  // Bullet list items (keep the text)
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
  // Blockquote markers
  out = out.replace(/^[ \t]*>[ \t]*/gm, '');
  // Table rows / dividers
  out = out.replace(/^\|.*\|[ \t]*$/gm, ' ');
  out = out.replace(/^[ \t]*:?-{3,}:?([ \t]*\|:?-{3,}:?)+[ \t]*$/gm, ' ');
  // Horizontal rules
  out = out.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ');

  // Emoji (common Unicode ranges)
  out = out.replace(
    /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|\u{200D}/gu,
    ' '
  );

  // Currency: ₹1,234.50 → "one thousand two hundred thirty four rupees fifty paise"
  out = out.replace(/₹(\d[\d,]*(?:\.\d{1,2})?)/g, (_m, n) => {
    const clean = n.replace(/,/g, '');
    const dot = clean.indexOf('.');
    const whole = dot < 0 ? clean : clean.slice(0, dot);
    const frac = dot < 0 ? '' : clean.slice(dot + 1).padEnd(2, '0').slice(0, 2);
    const w = parseInt(whole, 10);
    const parts = [];
    if (w === 1) parts.push('one rupee');
    else if (w > 0) parts.push(`${intToWords(w).join(' ')} rupees`);
    const cents = frac ? parseInt(frac, 10) : 0;
    if (cents === 1) parts.push('one paise');
    else if (cents > 0) parts.push(`${intToWords(cents).join(' ')} paise`);
    return parts.length ? parts.join(' ') : 'zero rupees';
  });
  out = out.replace(/₹/g, ' rupees ');

  out = out.replace(/\$(\d[\d,]*(?:\.\d{1,2})?)/g, (_m, n) => {
    const clean = n.replace(/,/g, '');
    const dot = clean.indexOf('.');
    const whole = dot < 0 ? clean : clean.slice(0, dot);
    const frac = dot < 0 ? '' : clean.slice(dot + 1).padEnd(2, '0').slice(0, 2);
    const w = parseInt(whole, 10);
    const parts = [];
    if (w === 1) parts.push('one dollar');
    else if (w > 0) parts.push(`${intToWords(w).join(' ')} dollars`);
    const cents = frac ? parseInt(frac, 10) : 0;
    if (cents === 1) parts.push('one cent');
    else if (cents > 0) parts.push(`${intToWords(cents).join(' ')} cents`);
    return parts.length ? parts.join(' ') : 'zero dollars';
  });
  out = out.replace(/\$/g, ' dollars ');

  // Percentages: "42%" → "42 percent"
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');

  // Common units (keep it short — expand only the clearest ones)
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*km\b/gi, '$1 kilometres');
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*kg\b/gi, '$1 kilograms');
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*mg\b/gi, '$1 milligrams');
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*gb\b/gi, '$1 gigabytes');
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*mb\b/gi, '$1 megabytes');
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*ms\b/gi, '$1 milliseconds');

  // Dates: DD/MM/YYYY or MM-DD-YYYY style → spoken
  out = out.replace(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g, (_m, a, b, y) => {
    const mo = parseInt(a, 10);
    const dy = parseInt(b, 10);
    const yr = parseInt(y, 10);
    const months = ['', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const moWord = months[mo] || a;
    return `${moWord} ${intToWords(dy).join(' ')} ${intToWords(yr).join(' ')}`;
  });

  // Plain numbers (with optional commas) → words, protect decimals
  // We replace numbers that are NOT part of a larger word.
  out = out.replace(/(?<!\w)(\d[\d,]*(?:\.\d+)?)(?!\w)/g, (_m, n) => numericStringToWords(n));

  // Collapse multiple spaces / newlines
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

// ─── Sentence segmenter ───────────────────────────────────────────────────────
// Terminal punctuation used to split sentences.
const TERMINATORS = /[.!?।]/;

/**
 * Split normalised text into sentences suitable for one TTS request each.
 * - Protects abbreviations (Dr., Mr. etc.) from splitting.
 * - Protects decimals.
 * - Handles ellipses and the Hindi danda (।).
 * - Splits overlong sentences at commas around 200 characters.
 *
 * @param {string} text
 * @returns {string[]}
 */
function segmentSentences(text) {
  if (typeof text !== 'string' || !text.trim()) return [];

  // Normalise ellipses and danda.
  let src = text;
  src = src.replace(/…|\.{3,}/g, '.');
  src = src.replace(/।/g, '.');

  // Replace decimal points with a placeholder so they never split.
  src = src.replace(/(\d)\.(\d)/g, '$1<DEC>$2');

  // Tokenise: split on sentence-ending punctuation, keeping the terminator.
  // Strategy: walk char by char, collecting tokens.
  const sentences = [];
  let buf = '';

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    buf += ch;

    if (!'.!?'.includes(ch)) continue;

    // Peek ahead: skip whitespace and closing quote/paren.
    let j = i + 1;
    while (j < src.length && /[\s"')}\]]/.test(src[j])) j += 1;

    // Don't split at end-of-string naturally — handled at loop end.
    const atEnd = j >= src.length;
    if (atEnd) break;

    // Check abbreviation: last word before the dot.
    if (ch === '.') {
      const wordMatch = buf.trimEnd().match(/([A-Za-z]{1,10})\.$/);
      if (wordMatch && ABBREVIATIONS.has(wordMatch[1].toLowerCase())) {
        continue; // abbreviation — keep going
      }
      // Single uppercase letter (initials like "J. K.")
      if (/\b[A-Z]\.$/.test(buf.trimEnd())) {
        continue;
      }
    }

    // Collect trailing punctuation chars (e.g. "!?").
    while (i + 1 < src.length && '.!?'.includes(src[i + 1])) {
      i += 1;
      buf += src[i];
    }
    // Also collect trailing close-quote / paren that belongs to the sentence.
    while (i + 1 < src.length && /['")\]}]/.test(src[i + 1])) {
      i += 1;
      buf += src[i];
    }

    const sentence = buf.replace(/<DEC>/g, '.').trim();
    if (sentence) sentences.push(sentence);
    buf = '';
  }

  if (buf.trim()) {
    sentences.push(buf.replace(/<DEC>/g, '.').trim());
  }

  // Split overlong sentences at commas (~200 chars).
  const MAX = 200;
  const result = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX) {
      result.push(sentence);
      continue;
    }
    const commas = sentence.split(',');
    let current = '';
    for (const chunk of commas) {
      const next = current ? `${current},${chunk}` : chunk;
      if (next.length > MAX && current.trim()) {
        result.push(current.trim());
        current = chunk;
      } else {
        current = next;
      }
    }
    if (current.trim()) result.push(current.trim());
  }

  return result.filter((s) => s.trim().length > 0);
}

module.exports = { normaliseForSpeech, segmentSentences, allVoices, findVoiceForLang, VOICES };
