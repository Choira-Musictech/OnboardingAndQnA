// ==================================================================
// What a member sees in the chat once registration is complete: the "Thank You for Registration!"
// card with the Application Number and IPRS's one Email ID (membership@iprs.org), once, and the
// same block under a "Welcome back!" heading on every later login - both fully covered by the
// shipped dictionary. Run: npm test
// ==================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));
delete process.env.IPRS_CONTACT_EMAIL;

const { paymentService } = await import('../src/modules/payment/services/payment.service.js');
const { handle } = await import('../src/modules/conversation/engines/aiEngine.js');
const { lookup } = await import('../src/modules/translation/dictionary.js');

test('the payment card carries the Application Number and membership@iprs.org, and is only shown once', () => {
  const text = paymentService.registrationCompleteText('900001');
  assert.match(text, /^Thank You for Registration!/);
  assert.match(text, /Application Number: 900001/);
  assert.match(text, /\nIPRS Email ID: membership@iprs\.org\n/);
  assert.match(text, /We have sent you a confirmation email from the IPRS team\.$/);
  assert.equal(paymentService.registrationCompleteText('900001'), null);
});

test('a relogin shows the payment card first, then the same block under a welcome back, each with one email', async () => {
  const first = (await handle({ userId: '900002' })).reply;
  assert.match(first, /Application Number: 900002/);
  assert.match(first, /IPRS Email ID: membership@iprs\.org/);

  const again = (await handle({ userId: '900002' })).reply;
  assert.match(again, /^Welcome back! Your IPRS registration is complete\./);
  assert.match(again, /Application Number: 900002/);
  assert.match(again, /IPRS Email ID: membership@iprs\.org/);
  assert.doesNotMatch(again, /confirmation email/);
  for (const text of [first, again]) {
    assert.equal((text.match(/@/g) ?? []).length, 1, 'only the one IPRS email');
    assert.doesNotMatch(text, /iprsolutions| or /);
  }
});

test('a typed message after completing still gets the plain reply', async () => {
  assert.equal((await handle({ userId: '900003', message: 'hi' })).reply, 'Your registration is complete. Thank you!');
});

test("the payment card's and relogin message's sentences all translate", () => {
  for (const language of ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or']) {
    for (const phrase of [
      'Thank You for Registration!',
      'Application Number',
      'IPRS Email ID',
      'We have sent you a confirmation email from the IPRS team.',
      'Welcome back! Your IPRS registration is complete.',
    ]) {
      assert.ok(lookup(phrase, language), `${language}: no translation for "${phrase}"`);
    }
  }
});
