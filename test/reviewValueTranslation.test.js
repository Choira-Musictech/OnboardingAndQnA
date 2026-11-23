// ==================================================================
// The review and saved-song lines in the member's language (node:test).
//
// "Label: value" lines translate the label always, and the value only when it is one of our own fixed
// options (Role, Category, Entity type...). What the member typed comes back as typed. Uses the real
// translations/flow-translations.json. No DB, no network. Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));
process.env.TRANSLATION_SUPPORTED_LANGUAGES = 'en,hi,mr,gu,bn,ur,ta,kn,te,or';

const { lookup } = await import('../src/modules/translation/dictionary.js');
const { formatValue } = await import('../src/modules/registration/services/registrationReview.service.js');

const translations = (await import('../translations/flow-translations.json', { with: { type: 'json' } })).default;
const t = (english, language) => translations[english][language];

const REVIEW = [
  'Please check your details before payment.',
  '',
  'Your details',
  '  Name: Publisher',
  '  Email: member@example.com',
  '',
  'Membership',
  '  Applying as: (NRI) Owner/Publisher',
  '  Role: Publisher',
  '  Entity type: Corporate (Pvt Ltd/Ltd Company)',
  '  Territory: WORLD',
  '  Dual nationality: Yes',
].join('\n');

const SAVED_SONG = ['Song details saved', '', 'Song: Inaam', 'Publisher: Sony Music', 'Category: Non Film', 'Language: hindi'].join('\n');

for (const language of ['mr', 'gu', 'hi']) {
  test(`fixed option values are shown in ${language}, labels too`, () => {
    const review = lookup(REVIEW, language);
    for (const [label, value] of [
      ['Applying as', '(NRI) Owner/Publisher'],
      ['Role', 'Publisher'],
      ['Entity type', 'Corporate (Pvt Ltd/Ltd Company)'],
      ['Territory', 'WORLD'],
      ['Dual nationality', 'Yes'],
    ]) {
      assert.ok(review.includes(`  ${t(label, language)}: ${t(value, language)}`), `${label}: ${value}`);
    }
    const song = lookup(SAVED_SONG, language);
    assert.ok(song.includes(`${t('Category', language)}: ${t('Non Film', language)}`), 'Category: Non Film');
  });

  test(`what the member typed stays as typed in ${language}`, () => {
    const review = lookup(REVIEW, language);
    assert.ok(review.includes(`  ${t('Name', language)}: Publisher`), 'a name that happens to be an option word is not translated');
    assert.ok(review.includes(': member@example.com'));
    const song = lookup(SAVED_SONG, language);
    assert.ok(song.includes(': Inaam'), 'song name');
    assert.ok(song.includes(': Sony Music'), "the song's publisher");
    assert.ok(song.includes(': hindi'), 'the language the member typed');
  });
}

test('a role list is translated part by part', () => {
  const line = lookup('Membership\n  Role: Composer, Lyricist', 'mr');
  assert.ok(line.includes(`${t('Role', 'mr')}: ${t('Composer', 'mr')}, ${t('Lyricist', 'mr')}`));
});

test('an option value with no translation keeps its English', () => {
  const line = lookup('Membership\n  Role: Something new', 'mr');
  assert.ok(line.includes(`${t('Role', 'mr')}: Something new`));
});

test('the review shows the territory, not the IPRS code', () => {
  assert.equal(formatValue('TeritoryAppFor', '2136'), 'WORLD');
  assert.equal(formatValue('TeritoryAppFor', '0356'), 'INDIA');
  assert.equal(formatValue('TeritoryAppFor', 'OTHER'), 'OTHER');
  assert.equal(formatValue('TeritoryAppFor', null), null);
});
