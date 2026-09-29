// ==================================================================
// Translations that ship with the project, rather than being fetched.
//
// The flow's wording is fixed and repeats for every member, so its Hindi,
// Marathi and Gujarati are written once into a JSON file and looked up here.
// That makes translation instant, free and identical every time - and it works
// with no API credential at all, which the hosted options do not.
//
// A string that is not in the file is left in English rather than guessed at.
// Reviewed wording matters here: this flow states fees, legal warnings and
// document requirements to people joining a rights society.
//
// The file is read once and kept in memory; it is a deployment artefact, so a
// change to it means a restart, the same as any other config.
// ==================================================================
import { readFileSync } from 'node:fs';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

let entries = null;

function load() {
  if (entries) return entries;

  const path = env.TRANSLATION_DICTIONARY_PATH;
  if (!path) {
    entries = new Map();
    return entries;
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    entries = new Map(Object.entries(raw).map(([english, langs]) => [english.trim(), langs]));
    logger.info({ path, phrases: entries.size }, 'Loaded flow translation dictionary');
  } catch (err) {
    // Missing or malformed: every member simply gets English.
    logger.warn({ path, err: err.message }, 'Could not load translation dictionary, answering in English');
    entries = new Map();
  }

  return entries;
}

export function isDictionaryConfigured() {
  return load().size > 0;
}

export function dictionarySize() {
  return load().size;
}

// Not every message is fixed text. The backend writes some itself, with a live
// value inside - "We've sent a 4-digit OTP to <the member's address>." Those are
// stored with {0} where the value goes, so one entry covers every member.
// Only emails and URLs are treated as variable: a bare number would wreck
// wording like "4-digit", and there is nothing to gain from replacing it.
const VARIABLE_PARTS = [
  // The domain is matched label by label so the regex cannot swallow the full
  // stop that ends the sentence - "...@gmail.com." must template to "{0}.", not "{0}".
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /https?:\/\/\S+/g,
  // "completed about 11% of it" - the number changes with every member, but the
  // per-cent sign does not, so it stays in the phrase and only the digits move.
  /\d+(?=%)/g,
];

function toTemplate(text) {
  const values = [];
  let template = text;

  for (const pattern of VARIABLE_PARTS) {
    template = template.replace(pattern, (match) => {
      values.push(match);
      return `{${values.length - 1}}`;
    });
  }

  return { template, values };
}

const fillIn = (text, values) => text.replace(/\{(\d+)\}/g, (whole, index) => values[Number(index)] ?? whole);

/**
 * The stored translation for one string, or null when it is not in the file.
 * Falls back to matching the message with its live values replaced by {0}, {1},
 * so a message carrying an email address still resolves.
 */
export function lookup(text, language) {
  const trimmed = String(text).trim();
  return wholeString(trimmed, language) ?? bySentence(trimmed, language);
}

/**
 * Some messages are assembled at runtime from parts that are each stored
 * separately - a reason followed by standing advice, or a greeting followed by
 * a progress line. Whole-string matching can never cover those, because the
 * combinations multiply.
 *
 * The text is cut into sentences and the longest run of them that the
 * dictionary knows is taken first, so an entry that is itself two sentences
 * ("OTP has expired. Please request a new OTP.") still matches as one piece. A
 * run with no entry keeps its English, which reads better than dropping it.
 */
function bySentence(text, language) {
  const pieces = text.split(/(\n+|(?<=[.!?])\s+)/);
  if (pieces.length < 3) return null;

  const units = [];
  for (let i = 0; i < pieces.length; i += 2) units.push({ text: pieces[i], after: pieces[i + 1] ?? '' });

  let translatedAny = false;
  const out = [];
  let start = 0;

  while (start < units.length) {
    let taken = 0;
    for (let end = units.length; end > start; end -= 1) {
      const run = units.slice(start, end).map((u, k) => u.text + (k < end - start - 1 ? u.after : '')).join('');
      const hit = wholeString(run.trim(), language);
      if (!hit) continue;
      out.push(run.replace(run.trim(), hit), units[end - 1].after);
      translatedAny = true;
      taken = end - start;
      break;
    }
    if (!taken) {
      out.push(units[start].text, units[start].after);
      taken = 1;
    }
    start += taken;
  }

  return translatedAny ? out.join('') : null;
}

/** An exact entry, or one whose variable parts have been templated out. */
function wholeString(text, language) {
  if (!text) return null;

  const exact = load().get(text)?.[language];
  if (typeof exact === 'string' && exact.trim()) return exact;

  const { template, values } = toTemplate(text);
  if (!values.length) return null;

  const templated = load().get(template)?.[language];
  return typeof templated === 'string' && templated.trim() ? fillIn(templated, values) : null;
}

// Translated label -> the English the flow knows, per language. A member taps a
// button reading "हाँ, मैं सदस्य बनना चाहता/चाहती हूँ" and that is what the browser
// sends back; Typebot only recognises its own English, and answers anything else
// with "Invalid message. Please, try again." So the answer is turned back before
// it reaches the flow.
let reverse = null;

function loadReverse() {
  if (reverse) return reverse;

  reverse = new Map();
  for (const [english, langs] of load().entries()) {
    for (const [language, translated] of Object.entries(langs ?? {})) {
      if (typeof translated !== 'string' || !translated.trim()) continue;
      const key = `${language}\u0000${translated.trim()}`;
      // First writer wins: two English phrases can share a translation, and
      // silently remapping to the later one would answer the wrong question.
      if (!reverse.has(key)) reverse.set(key, english);
    }
  }

  return reverse;
}

/**
 * The English the flow expects for something a member sent, or null when this is
 * not a known label - free text (a name, an address) must pass through untouched.
 */
export function lookupSource(text, language) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return loadReverse().get(`${language}\u0000${text.trim()}`) ?? null;
}

/** Provider shape: same length, same order; untranslated items come back unchanged. */
export async function dictionaryTranslate(texts, language) {
  return texts.map((text) => lookup(text, language) ?? text);
}

export const dictionaryProvider = {
  translate: dictionaryTranslate,
  isConfigured: isDictionaryConfigured,
};
