// ==================================================================
// The shipped translation file, checked as a whole (node:test).
//
// translationDictionary.test.js proves the lookup machinery against a small
// fixture. This proves the real file: every phrase is present in every
// supported language, and no translation drops or invents a {slot}, which
// would ship a sentence with a hole in it.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LANGUAGES = ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn'];
const dictionary = JSON.parse(readFileSync(new URL('../translations/flow-translations.json', import.meta.url), 'utf8'));
// Distinct slots: a translation may legitimately say {expected} once where English says it twice.
const slots = (text) => [...new Set([...text.matchAll(/\{[^}]+\}/g)].map((m) => m[0]))].sort();

test('every phrase is translated into every supported language', () => {
  for (const [phrase, entry] of Object.entries(dictionary)) {
    for (const language of LANGUAGES) {
      assert.ok(entry[language]?.trim(), `${language}: no translation for "${phrase.slice(0, 60)}"`);
    }
  }
});

test('a translation never drops or invents a slot', () => {
  for (const [phrase, entry] of Object.entries(dictionary)) {
    // {article} is deliberately absent from languages without articles (see ocrMessages.js).
    const expected = slots(phrase).filter((slot) => slot !== '{article}');
    for (const language of LANGUAGES) {
      const actual = slots(entry[language]).filter((slot) => slot !== '{article}');
      assert.deepEqual(actual, expected, `${language}: slots differ in "${phrase.slice(0, 60)}"`);
    }
  }
});
