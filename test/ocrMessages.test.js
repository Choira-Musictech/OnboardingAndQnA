// ==================================================================
// OCR refusals in the member's language (node:test).
//
// The OCR service answers in English only, and composes its sentences at
// runtime from a code plus a document name - ~800 of them. So the template is
// translated and the slots filled afterwards, matched on the service's `code`
// and never on its English text. These tests pin the three things that would
// quietly break that:
//   - a code resolving to the wrong template (the two WRONG_DOCUMENT_TYPE forms)
//   - a slot left unfilled, which ships a sentence with a hole in it
//   - {article} surviving into a language that has no articles
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeOcrMessage, ocrMessageCatalogue } from '../src/modules/translation/ocrMessages.js';

const LANGUAGES = ['hi', 'mr', 'gu', 'bn'];

test('a refusal is answered in each supported language', () => {
  const ocr = { code: 'DOCUMENT_NOT_REGISTERED', expectedDocument: 'PAN' };
  const seen = new Set();
  for (const language of LANGUAGES) {
    const message = composeOcrMessage(ocr, language);
    assert.ok(message, `no message for ${language}`);
    assert.ok(!/[{}]/.test(message), `unfilled slot in ${language}: ${message}`);
    seen.add(message);
  }
  assert.equal(seen.size, LANGUAGES.length, 'two languages produced the same sentence');
});

test('no language means no change - an English member reads the service as it is', () => {
  assert.equal(composeOcrMessage({ code: 'DOCUMENT_NOT_REGISTERED', expectedDocument: 'PAN' }, null), null);
});

test('{article} never survives into a language that has no articles', () => {
  const cases = [
    { code: 'WRONG_DOCUMENT_TYPE', expectedDocument: 'PAN', detectedDocument: 'BANK_CHEQUE' },
    { code: 'WRONG_DOCUMENT_TYPE', expectedDocument: 'PASSPORT', detectedDocument: null },
    { code: 'WRONG_HOLDER_TYPE', detectedHolderType: 'P', expectedHolderType: 'c' },
  ];
  for (const ocr of cases) {
    for (const language of LANGUAGES) {
      const message = composeOcrMessage(ocr, language);
      assert.ok(message, `${ocr.code} produced nothing for ${language}`);
      assert.ok(!/\ba\b|\ban\b/.test(message), `article left in ${language}: ${message}`);
    }
  }
});

test('the two WRONG_DOCUMENT_TYPE forms are told apart by detectedDocument', () => {
  const named = composeOcrMessage(
    { code: 'WRONG_DOCUMENT_TYPE', expectedDocument: 'PAN', detectedDocument: 'BANK_CHEQUE' },
    'hi',
  );
  const unnamed = composeOcrMessage(
    { code: 'WRONG_DOCUMENT_TYPE', expectedDocument: 'PAN', detectedDocument: null },
    'hi',
  );
  assert.ok(named && unnamed);
  assert.notEqual(named, unnamed, 'a recognised document and an unrecognised one read the same');

  // UNRECOGNISED is a sentinel, not a document - it must take the second form.
  const sentinel = composeOcrMessage(
    { code: 'WRONG_DOCUMENT_TYPE', expectedDocument: 'PAN', detectedDocument: 'UNRECOGNISED' },
    'hi',
  );
  assert.equal(sentinel, unnamed);
});

test('every mismatched field is named, and named in the member language', () => {
  const message = composeOcrMessage(
    { code: 'DOCUMENT_DETAILS_MISMATCH', expectedDocument: 'DRIVING_LICENCE', fields: ['name', 'dob'] },
    'hi',
  );
  assert.ok(message);
  assert.ok(!/\bdob\b/.test(message), `raw field key shown to a member: ${message}`);
  assert.ok(message.includes('जन्म तिथि'), `date of birth not translated: ${message}`);
});

test('a template that cannot be filled yields null rather than a broken sentence', () => {
  // No document name to put in {friendly}.
  assert.equal(composeOcrMessage({ code: 'DOCUMENT_NOT_REGISTERED', expectedDocument: 'NOT_A_TYPE' }, 'hi'), null);
  // A mismatch with nothing listed as mismatched.
  assert.equal(composeOcrMessage({ code: 'DOCUMENT_DETAILS_MISMATCH', expectedDocument: 'PAN', fields: [] }, 'hi'), null);
  // A code this service has never sent before.
  assert.equal(composeOcrMessage({ code: 'SOMETHING_ADDED_LATER' }, 'hi'), null);
  assert.equal(composeOcrMessage({}, 'hi'), null);
  assert.equal(composeOcrMessage(null, 'hi'), null);
});

test('a code a member cannot act on collapses to one apology', () => {
  const blocked = composeOcrMessage({ code: 'BLOCKED_DOCUMENT_URL' }, 'hi');
  const malformed = composeOcrMessage({ code: 'INVALID_BODY' }, 'hi');
  assert.ok(blocked);
  assert.equal(blocked, malformed, 'integration errors should read the same to a member');
  assert.ok(!/http|url|json/i.test(blocked), `internal detail leaked to a member: ${blocked}`);
});

test('every document type the OCR service can report has a readable name', () => {
  // The service's {detected} list. A type missing here renders a hole.
  const reportable = [
    'AADHAAR', 'ADDRESS_PROOF_COMPANY', 'ADDRESS_PROOF_INDIVIDUAL', 'BANK', 'BANK_CHEQUE',
    'BANK_LETTER', 'BANK_PASSBOOK', 'BANK_STATEMENT', 'BOARD_RESOLUTION', 'DRIVING_LICENCE',
    'ELECTRICITY', 'FORM_10F', 'GST', 'INCORPORATION', 'LEAVE_LICENSE', 'LETTER_FROM_OWNER',
    'MOA', 'MOBILE_BILL', 'MSME', 'NO_PE_DECLARATION', 'PAN', 'PASSPORT',
    'PUBLISHER_DECLARATION', 'SOCIETY_NOC', 'TELEPHONE_BILL', 'TIN', 'TRC', 'VOTER_ID',
  ];
  const missing = reportable.filter((type) => !ocrMessageCatalogue.DOCUMENT_NAMES[type]);
  assert.deepEqual(missing, [], `no readable name for: ${missing.join(', ')}`);
});

test('every holder type a PAN card can carry has a readable name', () => {
  const missing = ['P', 'C', 'F', 'A', 'B', 'T', 'H', 'L', 'J', 'G']
    .filter((code) => !ocrMessageCatalogue.HOLDER_TYPES[code]);
  assert.deepEqual(missing, [], `no readable name for holder type: ${missing.join(', ')}`);
});

// ------------------------------------------------------------------
// The chat path. An OCR refusal does not travel as an error response - it is
// caught in registration.service, carried as failureReason into a chat bubble
// by registrationEngine, and so never reaches errorHandler. That is why these
// messages stayed English after the error-handler work, and what this covers.
// ------------------------------------------------------------------
import { translateConversationPayload } from '../src/modules/translation/translation.service.js';
import { messageText } from '../src/modules/translation/messageBlocks.js';

function failureBubble(reason, ocrFailure) {
  return {
    messages: [{
      id: 'ocr-extraction-failed',
      type: 'text',
      content: {
        type: 'richText',
        richText: [{ type: 'p', children: [{ text: `We couldn't verify this PAN document:\n${reason}` }] }],
      },
      ...(ocrFailure ? { ocrFailure } : {}),
    }],
    input: null,
  };
}

const BANK_NOT_FOUND = {
  reason: 'Unable to extract valid BANK details from the linked document.',
  ocr: { code: 'DOCUMENT_NUMBER_NOT_FOUND', expectedDocument: 'BANK' },
};

test('an OCR refusal in a chat bubble is rebuilt in the member language', async () => {
  for (const language of LANGUAGES) {
    const out = await translateConversationPayload(
      failureBubble(BANK_NOT_FOUND.reason, BANK_NOT_FOUND.ocr),
      language,
    );
    const text = messageText(out.messages[0].content);
    assert.ok(!text.includes(BANK_NOT_FOUND.reason), `English survived in ${language}: ${text}`);
    assert.ok(!/\bBANK\b/.test(text), `raw document type shown in ${language}: ${text}`);
    assert.ok(!/[{}]/.test(text), `unfilled slot in ${language}: ${text}`);
  }
});

test('an English member still reads the OCR service exactly as it answered', async () => {
  for (const language of ['en', null]) {
    const out = await translateConversationPayload(
      failureBubble(BANK_NOT_FOUND.reason, BANK_NOT_FOUND.ocr),
      language,
    );
    assert.ok(messageText(out.messages[0].content).includes(BANK_NOT_FOUND.reason));
  }
});

test('a bubble with no OCR context is left to the ordinary dictionary pass', async () => {
  const out = await translateConversationPayload(failureBubble(BANK_NOT_FOUND.reason, null), 'hi');
  // Nothing to rebuild from, so the English reason survives rather than vanishing.
  assert.ok(messageText(out.messages[0].content).includes(BANK_NOT_FOUND.reason));
});

test('a holder type resolves from either the code or the word', () => {
  const expected = composeOcrMessage(
    { code: 'WRONG_HOLDER_TYPE', detectedHolderType: 'C', expectedHolderType: 'p' },
    'hi',
  );
  assert.ok(expected);
  for (const [detected, wanted] of [['Company', 'Individual'], ['company', 'individual']]) {
    assert.equal(
      composeOcrMessage({ code: 'WRONG_HOLDER_TYPE', detectedHolderType: detected, expectedHolderType: wanted }, 'hi'),
      expected,
      `${detected}/${wanted} did not resolve the same as the codes`,
    );
  }
  // A holder type nobody has mapped must not ship a sentence with a hole in it.
  assert.equal(
    composeOcrMessage({ code: 'WRONG_HOLDER_TYPE', detectedHolderType: 'Wizard', expectedHolderType: 'p' }, 'hi'),
    null,
  );
});

// "PAN" is deliberately left untranslated in every language (the user's explicit instruction) -
// only the surrounding wording changes. A holder-type mismatch is the one template that names
// "PAN" directly (not through a translated document name), so it's the one place this could slip.
test('a PAN holder-type mismatch keeps the word "PAN" literal in every language', () => {
  const ocr = { code: 'WRONG_HOLDER_TYPE', detectedHolderType: 'C', expectedHolderType: 'p' };
  for (const language of LANGUAGES) {
    const message = composeOcrMessage(ocr, language);
    assert.ok(message, `no message for ${language}`);
    assert.match(message, /PAN/, `${language}: "PAN" was translated away: ${message}`);
    assert.doesNotMatch(message, /PAN card/, `${language}: should say "PAN", not "PAN card"`);
  }
});
