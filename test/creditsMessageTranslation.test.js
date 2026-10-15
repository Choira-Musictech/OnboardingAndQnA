// ==================================================================
// The "not in this song's credits" prompt in the member's language (node:test).
//
// The message carries the song's own credited names, so it can never be a fixed
// dictionary key. These tests pin that the names are treated as a variable and
// the rest of the sentence is translated around them.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = new URL('../translations/flow-translations.json', import.meta.url).pathname;
process.env.TRANSLATION_SUPPORTED_LANGUAGES = 'en,hi,mr,gu,bn,ur,ta,kn,te,or';

const { lookup } = await import('../src/modules/translation/dictionary.js');
const { describeCredits } = await import('../src/modules/conversation/services/typebot/workLinkGate.js');

const LANGUAGES = ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or'];

test('the credits prompt is translated with the song\'s names kept as they are', () => {
  const names = ["Jasleen Royal", "Badshah", "Alvina D'Souza"];
  const english = describeCredits({ credits: names });

  for (const language of LANGUAGES) {
    const translated = lookup(english, language);
    assert.ok(translated, `${language}: the credits prompt is not translated`);
    assert.ok(translated.includes(names.join(', ')), `${language}: the credited names were lost`);
    assert.ok(!translated.includes("You're not listed"), `${language}: English survived`);
  }
});

test('the prompt without any names is translated too', () => {
  const english = describeCredits({ credits: [], artists: [], channelName: '' });
  for (const language of LANGUAGES) {
    assert.ok(lookup(english, language), `${language}: the no-names prompt is not translated`);
  }
});
