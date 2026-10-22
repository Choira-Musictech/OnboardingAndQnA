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

const { describeWorkDetailsPrompt } = await import('../src/modules/conversation/services/typebot/workDetailsGate.js');
const { dictionaryTranslate } = await import('../src/modules/translation/dictionary.js');

const askAbout = (name) => describeWorkDetailsPrompt({ field: 'Film_AlbumName', songName: name });

test('the film/album question asks for the name and says what to type for a single', () => {
  assert.equal(
    askAbout('Samjhawan'),
    'Is this "Samjhawan" part of a film or album? If yes, please enter the film or album name. If it is a standalone single, enter “Single”.',
  );
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
