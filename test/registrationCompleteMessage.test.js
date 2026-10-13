// ==================================================================
// What a member sees in the chat once registration is complete: the "Thank You for Registration!"
// card with the Application Number and IPRS Email ID, once, and the same block under a
// "Welcome back!" heading on every later login - both fully covered by the shipped dictionary.
// Run: npm test
// ==================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));

const { paymentService } = await import('../src/modules/payment/services/payment.service.js');
const { handle } = await import('../src/modules/conversation/engines/aiEngine.js');
const { lookup } = await import('../src/modules/translation/dictionary.js');

test('the payment card carries the Application Number, says the email is already sent, and is only shown once', () => {
  const text = paymentService.registrationCompleteText('900001');
  assert.match(text, /^Thank You for Registration!/);
  assert.match(text, /Application Number: 900001/);
  assert.match(text, /We have sent you a confirmation email from the IPRS team\.$/);
  assert.equal(paymentService.registrationCompleteText('900001'), null);
});

test('a relogin shows the payment card first, then the same Application Number block under a welcome back', async () => {
  const first = (await handle({ userId: '900002' })).reply;
  assert.match(first, /Application Number: 900002/);

  const again = (await handle({ userId: '900002' })).reply;
  assert.match(again, /^Welcome back! Your IPRS registration is complete\./);
  assert.match(again, /Application Number: 900002/);
  assert.doesNotMatch(again, /confirmation email/);
});

test('a typed message after completing still gets the plain reply', async () => {
  assert.equal((await handle({ userId: '900003', message: 'hi' })).reply, 'Your registration is complete. Thank you!');
});

test("the payment card's and relogin message's sentences all translate", () => {
  for (const language of ['hi', 'mr', 'gu', 'bn']) {
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
