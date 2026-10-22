// ==================================================================
// Every label on the "we extracted the following details" card is translated (node:test).
//
// The card is "Label: value" per line, built from OCR_FIELD_LABELS. A label missing from the
// dictionary stays English in the middle of an otherwise translated card, so this walks the
// whole table rather than checking labels one by one.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));
process.env.TRANSLATION_SUPPORTED_LANGUAGES = 'en,hi,mr,gu,bn,ur,ta,kn,te,or';

const { lookup } = await import('../src/modules/translation/dictionary.js');
const { OCR_FIELD_LABELS } = await import('../src/modules/conversation/engines/registrationEngine.js');

const LANGUAGES = ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or'];

test('every label an extracted-details card can show has a translation', () => {
  const labels = new Set(Object.values(OCR_FIELD_LABELS).flatMap((fields) => Object.values(fields)));
  for (const label of labels) {
    for (const language of LANGUAGES) {
      assert.ok(lookup(label, language), `${language}: no translation for the card label "${label}"`);
    }
  }
});
