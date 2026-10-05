// ==================================================================
// Translating what the chatbot says, on the way out.
//
// The flow is authored once, in English, in Typebot. Rather than maintain a
// translated copy of every block - which would drift the moment anyone edits
// the flow - the English payload is translated as it leaves the API, keyed on
// the language the member picked on the first screen.
//
// THREE THINGS THIS DELIBERATELY DOES:
//
// 1. Caches. The flow says the same few hundred sentences to every member, so
//    without a cache every member would pay for the same translation again.
//    Cache hits also cost nothing in latency, which is what keeps the chat
//    feeling immediate after the first member through a given step.
// 2. Sends one request per response, not one per string, by batching the whole
//    payload into a single array.
// 3. Never throws and never blocks the reply. If the provider is unconfigured,
//    out of credit, slow or wrong, the member gets the English text - the same
//    rule gemini.service.js follows for YouTube titles. A translation outage
//    must not become a registration outage.
// ==================================================================
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getProvider } from './providers.js';
import { lookupSource, lookup } from './dictionary.js';
import { composeOcrMessage } from './ocrMessages.js';
import { collectTranslatable, applyTranslations } from './translatableFields.js';
import { messageText, rebuildMessage } from './messageBlocks.js';

// text -> translation, keyed per language. Bounded so a long-running process
// cannot grow without limit; the flow's vocabulary is far smaller than the cap.
const cache = new Map();

const cacheKey = (language, text) => `${language}\u0000${text}`;

function readCache(language, text) {
  return cache.get(cacheKey(language, text));
}

function writeCache(language, text, translation) {
  if (cache.size >= env.TRANSLATION_CACHE_MAX) {
    // Oldest first: Map preserves insertion order, so this is a plain FIFO.
    cache.delete(cache.keys().next().value);
  }
  cache.set(cacheKey(language, text), translation);
}

export function supportedLanguages() {
  return String(env.TRANSLATION_SUPPORTED_LANGUAGES)
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The language to answer in, or null to leave the payload alone. Null covers
 * every "do nothing" case: translation switched off, no language asked for,
 * the language the flow is already written in, and anything unsupported.
 */
export function resolveTargetLanguage(requested) {
  if (!env.TRANSLATION_ENABLED) return null;

  const code = String(requested ?? '').trim().toLowerCase();
  if (!code) return null;
  if (code === env.TRANSLATION_SOURCE_LANGUAGE) return null;
  if (!supportedLanguages().includes(code)) return null;

  return code;
}

export function isTranslationConfigured() {
  return Boolean(env.TRANSLATION_ENABLED) && getProvider().isConfigured();
}

/**
 * Translates `texts`, returning an array of the same length and order.
 * Anything the provider could not translate comes back in its original wording.
 */
export async function translateTexts(texts, targetLanguage) {
  if (!targetLanguage || !Array.isArray(texts) || texts.length === 0) return texts;

  const result = [...texts];
  const missingIndexes = [];

  texts.forEach((text, index) => {
    const hit = readCache(targetLanguage, text);
    if (hit === undefined) missingIndexes.push(index);
    else result[index] = hit;
  });

  if (missingIndexes.length === 0) return result;
  if (!getProvider().isConfigured()) return result;

  const translated = await getProvider().translate(
    missingIndexes.map((index) => texts[index]),
    targetLanguage,
  );

  if (!translated) return result;

  missingIndexes.forEach((index, position) => {
    const value = translated[position];
    if (typeof value !== 'string' || !value.trim()) return;
    result[index] = value;
    writeCache(targetLanguage, texts[index], value);
  });

  return result;
}

/**
 * The conversation payload, with everything the member reads in their language.
 * Returns the payload untouched when there is nothing to do.
 */
const OCR_FAILURE_LEAD = "We couldn't verify this document:";

/**
 * A bubble carrying `ocrFailure` is rewritten from that code rather than
 * translated from its English. The OCR service composes its refusals at
 * runtime from a document name - ~800 sentences - so none of them is a
 * dictionary key and the generic pass below would leave every one in English.
 *
 * The document type is dropped from the lead-in because the rebuilt sentence
 * names the document itself; keeping both said it twice.
 */
function rebuildOcrFailures(payload, targetLanguage) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.some((m) => m?.ocrFailure)) return payload;

  const lead = lookup(OCR_FAILURE_LEAD, targetLanguage) ?? OCR_FAILURE_LEAD;

  return {
    ...payload,
    messages: messages.map((m) => {
      if (!m?.ocrFailure) return m;
      const composed = composeOcrMessage(m.ocrFailure, targetLanguage);
      // No template for this code yet: leave the English, which is still a
      // true account of what happened.
      if (!composed) return m;
      return { ...m, content: rebuildMessage(m.content, `${lead}\n${composed}`, targetLanguage) };
    }),
  };
}

export async function translateConversationPayload(payload, requestedLanguage) {
  const targetLanguage = resolveTargetLanguage(requestedLanguage);
  if (!targetLanguage || !payload) return payload;

  // Before the generic pass, so the rebuilt sentence is not then looked up and
  // missed. A bubble this rewrites is already in the member's language.
  payload = rebuildOcrFailures(payload, targetLanguage);

  // Bubbles first, as whole messages: a sentence split across bold/link nodes is
  // only translatable - and only matches the dictionary - when it is joined back up.
  let working = payload;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const bubbleTexts = messages.map((m) => (m?.content?.richText ? messageText(m.content) : '')).filter(Boolean);

  if (bubbleTexts.length) {
    const translatedBubbles = await translateTexts(bubbleTexts, targetLanguage);
    const byOriginal = new Map();
    bubbleTexts.forEach((text, i) => {
      if (translatedBubbles[i] && translatedBubbles[i] !== text) byOriginal.set(text, translatedBubbles[i]);
    });

    if (byOriginal.size) {
      working = {
        ...payload,
        messages: messages.map((m) => {
          if (!m?.content?.richText) return m;
          const hit = byOriginal.get(messageText(m.content));
          return hit ? { ...m, content: rebuildMessage(m.content, hit, targetLanguage) } : m;
        }),
      };
    }
  }

  // Then everything else a member reads: button labels and input hints.
  const originals = collectTranslatable(working);
  if (originals.length === 0) return working;

  try {
    const translated = await translateTexts(originals, targetLanguage);
    const map = new Map();
    originals.forEach((text, index) => {
      if (translated[index] && translated[index] !== text) map.set(text, translated[index]);
    });

    if (map.size === 0) return working;
    return applyTranslations(working, map);
  } catch (err) {
    // Belt and braces: the providers already swallow their own failures.
    logger.warn({ err: err.message, targetLanguage }, 'Translation failed, answering in the original language');
    return payload;
  }
}

/**
 * What the member sent, in the language the flow is written in. Only exact
 * matches of known labels are mapped; everything else - names, addresses, work
 * links - is returned untouched.
 */
export function toSourceText(text, requestedLanguage) {
  const targetLanguage = resolveTargetLanguage(requestedLanguage);
  if (!targetLanguage) return text;
  return lookupSource(text, targetLanguage) ?? text;
}

/** Exposed for the tests and for /health-style checks. */
export function translationCacheSize() {
  return cache.size;
}

export function clearTranslationCache() {
  cache.clear();
}

export const translationService = {
  translateConversationPayload,
  toSourceText,
  translateTexts,
  resolveTargetLanguage,
  supportedLanguages,
  isTranslationConfigured,
  translationCacheSize,
  clearTranslationCache,
};
