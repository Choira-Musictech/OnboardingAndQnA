// ==================================================================
// Translation of outgoing chat payloads.
//
// The rules that matter here are the ones that keep the flow working when a
// translation is in play: identity (ids, URLs, variable ids) survives, and a
// provider that is unconfigured or failing leaves the English text in place
// rather than blanking the chat.
// ==================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRANSLATION_ENABLED = 'true';
// This file tests the degrade-to-English path, so it pins a provider that has no
// credential here. The dictionary provider is covered in translationDictionary.test.js.
process.env.TRANSLATION_PROVIDER = 'gemini';
process.env.TRANSLATION_DICTIONARY_PATH = '';
process.env.TRANSLATION_SUPPORTED_LANGUAGES = 'en,hi,mr,gu';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_TRANSLATE_API_KEY = '';
process.env.GOOGLE_TRANSLATE_TOKEN = '';

const { collectTranslatable, applyTranslations } = await import('../src/modules/translation/translatableFields.js');
const { resolveTargetLanguage, translateTexts, translateConversationPayload, isTranslationConfigured } =
  await import('../src/modules/translation/translation.service.js');

// A payload in the shape the conversation endpoints actually return.
const payload = () => ({
  sessionEnded: false,
  progress: 42,
  messages: [
    {
      id: 'h6286lac2whzlcwyg7q1ygd5',
      type: 'text',
      content: {
        type: 'richText',
        richText: [
          { type: 'p', children: [{ text: 'Please upload your PAN Card.' }] },
          {
            type: 'p',
            children: [
              { text: 'Read the ' },
              { type: 'a', url: 'https://iprs.org/privacy.pdf', children: [{ text: 'Privacy Notice' }] },
            ],
          },
        ],
      },
    },
  ],
  input: {
    id: 'ofaqjfre4b6smht07inyag0w',
    type: 'choice input',
    items: [
      { id: 'nc5d3udlltbv0g9f3thmaqni', content: '(Individual) Author / Composer' },
      { id: 'kz4ejlwsqtl25k48qtpoe53p', content: 'Owner/Publisher' },
    ],
    options: { variableId: 'vjxwoc559admtu01nvecsfrbe', labels: { placeholder: 'Type your answer' } },
  },
});

test('collects every member-facing string and nothing else', () => {
  const found = collectTranslatable(payload());

  assert.ok(found.includes('Please upload your PAN Card.'));
  assert.ok(found.includes('Privacy Notice'), 'link text is read by the member, so it is translated');
  assert.ok(found.includes('(Individual) Author / Composer'));
  assert.ok(found.includes('Type your answer'));

  // Identity must never be offered for translation.
  assert.ok(!found.includes('https://iprs.org/privacy.pdf'), 'a URL must not be translated');
  assert.ok(!found.includes('vjxwoc559admtu01nvecsfrbe'));
  assert.ok(!found.includes('choice input'));
  assert.ok(!found.includes('ofaqjfre4b6smht07inyag0w'));
});

test('applying translations keeps ids, URLs and structure intact', () => {
  const map = new Map([
    ['Please upload your PAN Card.', 'कृपया अपना पैन कार्ड अपलोड करें।'],
    ['Owner/Publisher', 'स्वामी/प्रकाशक'],
  ]);

  const out = applyTranslations(payload(), map);

  assert.equal(out.messages[0].content.richText[0].children[0].text, 'कृपया अपना पैन कार्ड अपलोड करें।');
  assert.equal(out.input.items[1].content, 'स्वामी/प्रकाशक');

  // Untouched by design.
  assert.equal(out.messages[0].id, 'h6286lac2whzlcwyg7q1ygd5');
  assert.equal(out.messages[0].content.richText[1].children[1].url, 'https://iprs.org/privacy.pdf');
  assert.equal(out.input.options.variableId, 'vjxwoc559admtu01nvecsfrbe');
  assert.equal(out.input.type, 'choice input');
  assert.equal(out.progress, 42);

  // A string missing from the map keeps its English wording.
  assert.equal(out.input.items[0].content, '(Individual) Author / Composer');
});

test('the original payload is never mutated', () => {
  const original = payload();
  applyTranslations(original, new Map([['Owner/Publisher', 'स्वामी/प्रकाशक']]));
  assert.equal(original.input.items[1].content, 'Owner/Publisher');
});

test('resolveTargetLanguage answers null for every do-nothing case', () => {
  assert.equal(resolveTargetLanguage('en'), null, 'the flow is already English');
  assert.equal(resolveTargetLanguage(''), null);
  assert.equal(resolveTargetLanguage(undefined), null);
  assert.equal(resolveTargetLanguage('fr'), null, 'not in the supported list');
  assert.equal(resolveTargetLanguage('hi'), 'hi');
  assert.equal(resolveTargetLanguage('  HI  '), 'hi', 'case and spacing are forgiven');
});

test('an unconfigured provider leaves the text in English instead of failing', async () => {
  assert.equal(isTranslationConfigured(), false, 'no provider credential is set in this test');

  const texts = ['Please upload your PAN Card.'];
  assert.deepEqual(await translateTexts(texts, 'hi'), texts);

  const out = await translateConversationPayload(payload(), 'hi');
  assert.equal(out.messages[0].content.richText[0].children[0].text, 'Please upload your PAN Card.');
  assert.equal(out.input.items[1].content, 'Owner/Publisher');
});

test('a payload is returned untouched when no language is asked for', async () => {
  const original = payload();
  assert.equal(await translateConversationPayload(original, undefined), original);
  assert.equal(await translateConversationPayload(original, 'en'), original);
});
