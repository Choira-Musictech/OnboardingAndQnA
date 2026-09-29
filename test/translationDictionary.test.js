// ==================================================================
// The shipped-dictionary provider, and translating a bubble as one message.
//
// These two together are what lets a member see their own language only:
// the flow stays in English, and the reply is rewritten on the way out.
// ==================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'iprs-tx-'));
const dictPath = join(dir, 'dict.json');
writeFileSync(dictPath, JSON.stringify({
  'Please upload your PAN Card.': { hi: 'कृपया अपना PAN कार्ड अपलोड करें।', mr: 'कृपया तुमचे PAN कार्ड अपलोड करा.', gu: 'કૃપા કરીને તમારું PAN કાર્ડ અપલોડ કરો.' },
  'Upload Address Proof\nPlease upload any one of the following documents as proof of your permanent address:':
    { hi: 'पते का प्रमाण अपलोड करें\nकृपया स्थायी पते का कोई एक दस्तावेज़ अपलोड करें:', mr: 'x', gu: 'y' },
  Passport: { hi: 'पासपोर्ट', mr: 'पासपोर्ट', gu: 'પાસપોર્ટ' },
  "We've sent a 4-digit OTP to {0}. Enter it to verify.": {
    hi: 'हमने {0} पर 4 अंकों का OTP भेजा है। सत्यापित करने के लिए इसे दर्ज करें।', mr: 'x', gu: 'y' },
}), 'utf8');

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = dictPath;
process.env.TRANSLATION_SUPPORTED_LANGUAGES = 'en,hi,mr,gu';

const { lookup, dictionarySize } = await import('../src/modules/translation/dictionary.js');
const { messageText, rebuildMessage } = await import('../src/modules/translation/messageBlocks.js');
const { translateConversationPayload, toSourceText } = await import('../src/modules/translation/translation.service.js');

test('the dictionary is loaded and answers per language', () => {
  assert.equal(dictionarySize(), 4);
  assert.equal(lookup('Passport', 'gu'), 'પાસપોર્ટ');
  assert.equal(lookup('Passport', 'hi'), 'पासपोर्ट');
  assert.equal(lookup('not in the flow', 'hi'), null, 'an unknown phrase stays English rather than being guessed');
});

test('a sentence split across formatting nodes is read as one message', () => {
  const content = { type: 'richText', richText: [
    { type: 'p', children: [{ text: 'Upload Address Proof' }] },
    { type: 'p', children: [
      { text: 'Please upload any one of the following documents as proof of your ' },
      { bold: true, text: 'permanent ' },
      { text: 'address:' },
    ] },
  ] };
  assert.equal(
    messageText(content),
    'Upload Address Proof\nPlease upload any one of the following documents as proof of your permanent address:',
  );
});

test('rebuilding keeps the link and its URL', () => {
  const content = { type: 'richText', richText: [
    { type: 'p', children: [
      { text: 'Self Declaration Letter ' },
      { type: 'a', url: 'https://docs.google.com/document/d/1vJc', children: [{ text: '(Click Here to Download)' }] },
    ] },
  ] };
  const out = rebuildMessage(content, 'स्व-घोषणा पत्र');
  const json = JSON.stringify(out);
  assert.match(json, /स्व-घोषणा पत्र/);
  assert.match(json, /https:\/\/docs\.google\.com\/document\/d\/1vJc/, 'the download link must survive translation');
});

test('only the requested language comes back - never several at once', async () => {
  const payload = () => ({
    messages: [{ id: 'm1', type: 'text', content: { type: 'richText', richText: [
      { type: 'p', children: [{ text: 'Please upload your PAN Card.' }] },
    ] } }],
    input: { id: 'i1', type: 'choice input', items: [{ id: 'c1', content: 'Passport' }] },
  });

  const hi = JSON.stringify(await translateConversationPayload(payload(), 'hi'));
  assert.match(hi, /कृपया अपना PAN कार्ड अपलोड करें।/);
  assert.match(hi, /पासपोर्ट/);
  assert.doesNotMatch(hi, /Please upload your PAN Card/, 'the English must be replaced, not appended');
  assert.doesNotMatch(hi, /પાસપોર્ટ/, 'no other language may appear');

  const gu = JSON.stringify(await translateConversationPayload(payload(), 'gu'));
  assert.match(gu, /પાસપોર્ટ/);
  assert.doesNotMatch(gu, /पासपोर्ट/);

  const en = await translateConversationPayload(payload(), 'en');
  assert.equal(en.messages[0].content.richText[0].children[0].text, 'Please upload your PAN Card.');
});

test('a button tapped in another language reaches the flow as English', async () => {
  // Without this the browser sends back the translated label and Typebot answers
  // "Invalid message. Please, try again." - the flow only knows its own wording.
  const payload = { messages: [], input: { id: 'i1', type: 'choice input', items: [{ id: 'c1', content: 'Passport' }] } };

  for (const [language, expected] of [['hi', 'पासपोर्ट'], ['gu', 'પાસપોર્ટ']]) {
    const shown = (await translateConversationPayload(structuredClone(payload), language)).input.items[0].content;
    assert.equal(shown, expected, 'the member sees their own language');
    assert.equal(toSourceText(shown, language), 'Passport', 'the flow receives its own English');
  }
});

test('free text is never rewritten on the way in', () => {
  // Names, addresses and work links are not labels and must survive verbatim.
  for (const text of ['Nirnay Sawant', 'https://open.spotify.com/track/abc', '04 Sawant chawl, Thane']) {
    assert.equal(toSourceText(text, 'hi'), text);
  }
  assert.equal(toSourceText('पासपोर्ट', 'en'), 'पासपोर्ट', 'an English session maps nothing');
  assert.equal(toSourceText(undefined, 'hi'), undefined, 'a start call sends no message at all');
});

test('a message carrying a live value matches one stored entry', () => {
  // The backend writes some messages itself with the member's own address inside.
  // One dictionary entry has to serve every member, so the address is templated
  // out for the lookup and put back afterwards.
  const forNirnay = lookup("We've sent a 4-digit OTP to nirnaysawant21@gmail.com. Enter it to verify.", 'hi');
  assert.match(forNirnay, /nirnaysawant21@gmail\.com/, 'the address must survive');
  assert.match(forNirnay, /4 अंकों का OTP/);

  const forMaya = lookup("We've sent a 4-digit OTP to maya.mishra@choira.io. Enter it to verify.", 'hi');
  assert.match(forMaya, /maya\.mishra@choira\.io/, 'the same entry serves a different member');

  // The address must not swallow the full stop that ends the sentence.
  assert.match(forNirnay, /gmail\.com पर/, 'the sentence after the address is kept');
  assert.equal(lookup('Totally unknown sentence with bob@example.com in it.', 'hi'), null);
});
