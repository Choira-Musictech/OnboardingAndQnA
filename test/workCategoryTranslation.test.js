// ==================================================================
// The work-category choices in the member's language (node:test).
//
// The five categories are written to the database in English, so what the member taps has to
// map back to them exactly. These tests pin both directions.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));
process.env.TRANSLATION_SUPPORTED_LANGUAGES = 'en,hi,mr,gu,bn,ur,ta,kn,te,or';

const { translateConversationPayload, toSourceText } = await import('../src/modules/translation/translation.service.js');
const { WORK_CATEGORY_OPTIONS, parseWorkCategory } = await import('../src/modules/conversation/services/typebot/workDetailsGate.js');

const LANGUAGES = ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or'];
const choice = () => ({
  messages: [],
  input: { id: 'work-category', type: 'choice input', items: WORK_CATEGORY_OPTIONS.map((content, i) => ({ id: `c${i}`, content })) },
});

test('every work category is shown in the member language and tapping it maps back to the English value', async () => {
  for (const language of LANGUAGES) {
    const out = await translateConversationPayload(choice(), language);
    out.input.items.forEach((item, i) => {
      const english = WORK_CATEGORY_OPTIONS[i];
      assert.notEqual(item.content, english, `${language}: "${english}" stayed in English`);
      assert.equal(parseWorkCategory(toSourceText(item.content, language)), english, `${language}: "${item.content}" does not map back to "${english}"`);
    });
  }
});
