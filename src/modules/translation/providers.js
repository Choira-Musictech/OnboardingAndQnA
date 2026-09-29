// ==================================================================
// The two ways this project can reach Google for a translation.
//
// google  - Cloud Translation (v2 REST). The documented product, and what
//           IPRS asked for. Note Google no longer accepts a plain API key
//           on this API for every project: it answers 401 "API keys are not
//           supported by this API" and wants a service account. Set
//           GOOGLE_TRANSLATE_API_KEY if your project still allows keys,
//           otherwise use an OAuth access token in GOOGLE_TRANSLATE_TOKEN.
//
// gemini  - The generative endpoint this repo already talks to for YouTube
//           titles (see work/services/gemini.service.js). It accepts a plain
//           API key, so it works where Cloud Translation refuses one.
//
// Both take an array and return an array of the same length, in order.
// Neither throws: a failure returns null and the caller keeps the English.
// ==================================================================
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { dictionaryProvider } from './dictionary.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

// Asking for JSON back is what keeps the mapping positional: one array in,
// one array out, so item 3 is always the translation of item 3.
const GEMINI_INSTRUCTION = [
  'You are translating the user interface of an Indian music-rights membership chatbot.',
  'Translate each string in the JSON array into the target language.',
  'Return ONLY a JSON array of strings, the same length and order as the input.',
  'Keep these EXACTLY as they appear, untranslated: URLs, email addresses, numbers,',
  'currency amounts and their symbols, document names written in capitals (PAN, GST, NOC, IPRS),',
  'and any text inside {{ }}.',
  'Translate naturally, as a person would speak, not word by word.',
].join(' ');

function geminiConfigured() {
  return Boolean(env.GEMINI_API_KEY);
}

async function geminiTranslate(texts, targetLanguage) {
  if (!geminiConfigured()) return null;

  const body = {
    systemInstruction: { parts: [{ text: `${GEMINI_INSTRUCTION} Target language code: ${targetLanguage}.` }] },
    contents: [{ parts: [{ text: JSON.stringify(texts) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };

  const model = env.TRANSLATION_GEMINI_MODEL || env.GEMINI_MODEL;

  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.TRANSLATION_REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      // 402/429 here means the key is out of quota or credit - worth naming in the
      // log, because the symptom (English text) is otherwise silent.
      logger.warn({ status: response.status }, 'Gemini translation failed, keeping the original text');
      return null;
    }

    const payload = await response.json();
    const raw = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== texts.length) {
      logger.warn({ expected: texts.length, got: Array.isArray(parsed) ? parsed.length : null },
        'Gemini returned a different number of strings, keeping the original text');
      return null;
    }

    return parsed.map((value, index) => (typeof value === 'string' && value.trim() ? value : texts[index]));
  } catch (err) {
    logger.warn({ err: err.message }, 'Gemini translation errored, keeping the original text');
    return null;
  }
}

function googleConfigured() {
  return Boolean(env.GOOGLE_TRANSLATE_API_KEY || env.GOOGLE_TRANSLATE_TOKEN);
}

async function googleTranslate(texts, targetLanguage) {
  if (!googleConfigured()) return null;

  const url = new URL(GOOGLE_TRANSLATE_URL);
  const headers = { 'Content-Type': 'application/json' };

  // A service-account / OAuth access token is the form Cloud Translation accepts
  // everywhere; the API key is kept for projects that still permit it.
  if (env.GOOGLE_TRANSLATE_TOKEN) headers.Authorization = `Bearer ${env.GOOGLE_TRANSLATE_TOKEN}`;
  else url.searchParams.set('key', env.GOOGLE_TRANSLATE_API_KEY);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ q: texts, target: targetLanguage, format: 'text' }),
      signal: AbortSignal.timeout(env.TRANSLATION_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn({ status: response.status, detail: detail.slice(0, 200) },
        'Cloud Translation failed, keeping the original text');
      return null;
    }

    const payload = await response.json();
    const list = payload?.data?.translations;
    if (!Array.isArray(list) || list.length !== texts.length) return null;

    return list.map((item, index) => (typeof item?.translatedText === 'string' ? item.translatedText : texts[index]));
  } catch (err) {
    logger.warn({ err: err.message }, 'Cloud Translation errored, keeping the original text');
    return null;
  }
}

const PROVIDERS = {
  // Ships with the project: instant, free, reviewed, and needs no credential.
  dictionary: dictionaryProvider,
  gemini: { translate: geminiTranslate, isConfigured: geminiConfigured },
  google: { translate: googleTranslate, isConfigured: googleConfigured },
};

export function getProvider(name = env.TRANSLATION_PROVIDER) {
  return PROVIDERS[name] ?? PROVIDERS.gemini;
}

export const translationProviders = PROVIDERS;
