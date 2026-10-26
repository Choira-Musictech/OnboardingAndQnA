// ==================================================================
// The follow-up question asked after "Yes, that's my song" (node:test): what it says, and that it
// still reads in every language with the song's name left exactly as the member gave it.
// Run: npm test
// ==================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));

const { describeWorkDetailsPrompt, describeWorkDetailsRetry } = await import('../src/modules/conversation/services/typebot/workDetailsGate.js');
const { dictionaryTranslate } = await import('../src/modules/translation/dictionary.js');

const askAbout = (name) => describeWorkDetailsPrompt({ field: 'Film_AlbumName', songName: name });

test('the film/album question only asks for the film or album name', () => {
  assert.equal(askAbout('Samjhawan'), 'Please enter the film or album name for "Samjhawan".');
  assert.equal(/single/i.test(askAbout('Samjhawan')), false, 'no "Single" option is offered');
});

test('the film/album question is translated into every language and keeps the song name as typed', async () => {
  for (const language of ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or']) {
    for (const song of ['Samjhawan', 'Tum Hi Ho']) {
      const english = askAbout(song);
      const [translated] = await dictionaryTranslate([english], language);
      assert.notEqual(translated, english, `${language}: not translated`);
      assert.ok(translated.includes(`"${song}"`), `${language}: the song name must survive as typed`);
    }
  }
});

test('the film/album retry asks for the name again and is translated into every language', async () => {
  const retry = describeWorkDetailsRetry({ field: 'Film_AlbumName' });
  assert.equal(retry, 'Please enter the film or album name.');
  for (const language of ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or']) {
    const [translated] = await dictionaryTranslate([retry], language);
    assert.notEqual(translated, retry, `${language}: not translated`);
  }
});
