// ==================================================================
// TeritoryAppFor now stores IPRS's numeric codes (WORLD -> 2136, INDIA -> 0356) instead of the
// raw chat answer text, and Nationality defaults to "Indian" on completion for the three paths
// that never ask it. Both defaults are idempotent - a value already on the account always wins.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrationService } from '../src/modules/registration/services/registration.service.js';
import { registrationRepository } from '../src/modules/registration/repositories/registration.repository.js';
import { paymentRepository } from '../src/modules/payment/repositories/payment.repository.js';
import { registrationEmailService } from '../src/modules/registration/services/registrationEmail.service.js';

const ACCOUNT = { AccountId: 77001n, AccountEmail: 'member@example.com' };

test('saveConversationField maps the territory answer to IPRS\'s numeric code', async () => {
  const original = { findByAccountId: registrationRepository.findByAccountId, update: registrationRepository.update };
  let written;
  registrationRepository.update = async (_id, data) => { written = data; };
  try {
    await registrationService.saveConversationField('77002', '77002', 'TeritoryAppFor', 'WORLD');
    assert.deepEqual(written, { TeritoryAppFor: '2136' });

    await registrationService.saveConversationField('77002', '77002', 'TeritoryAppFor', 'india');
    assert.deepEqual(written, { TeritoryAppFor: '0356' }, 'case-insensitive, and the leading zero survives in the text column');

    written = undefined;
    await registrationService.saveConversationField('77002', '77002', 'TeritoryAppFor', 'Mars');
    assert.equal(written, undefined, 'an answer that is neither WORLD nor INDIA is not written at all');
  } finally {
    registrationRepository.update = original.update;
    registrationRepository.findByAccountId = original.findByAccountId;
  }
});

// complete() itself, dependencies stubbed - same pattern as registrationEmail.test.js's runComplete.
async function runComplete(accountOverrides) {
  const original = {
    findByAccountId: registrationRepository.findByAccountId,
    findDocumentsByAccountId: registrationRepository.findDocumentsByAccountId,
    markCompleted: registrationRepository.markCompleted,
    update: registrationRepository.update,
    hasSuccessfulPayment: paymentRepository.hasSuccessfulPayment,
    sendCompletionEmails: registrationEmailService.sendCompletionEmails,
  };
  const updates = [];

  registrationRepository.findByAccountId = async () => ({ ...ACCOUNT, ApplicationStatus: 1, ...accountOverrides });
  registrationRepository.findDocumentsByAccountId = async () => ['PAN', 'BANK', 'PERMANENT_ADDRESS_PROOF'].map((DocumentName) => ({ DocumentName }));
  registrationRepository.markCompleted = async () => false;
  registrationRepository.update = async (_id, data) => { updates.push(data); };
  paymentRepository.hasSuccessfulPayment = async () => true;
  registrationEmailService.sendCompletionEmails = async () => {};

  try {
    await registrationService.complete('77001', '77001');
    return updates;
  } finally {
    Object.assign(registrationRepository, {
      findByAccountId: original.findByAccountId,
      findDocumentsByAccountId: original.findDocumentsByAccountId,
      markCompleted: original.markCompleted,
      update: original.update,
    });
    paymentRepository.hasSuccessfulPayment = original.hasSuccessfulPayment;
    registrationEmailService.sendCompletionEmails = original.sendCompletionEmails;
  }
}

test('complete() defaults both Nationality and TeritoryAppFor when they were never answered', async () => {
  const updates = await runComplete({ Nationality: null, TeritoryAppFor: null });
  assert.deepEqual(updates.find((u) => 'Nationality' in u), { Nationality: 'Indian' });
  assert.deepEqual(updates.find((u) => 'TeritoryAppFor' in u), { TeritoryAppFor: '2136' });
});

test('complete() leaves an already-answered Nationality/TeritoryAppFor alone', async () => {
  const updates = await runComplete({ Nationality: 'British', TeritoryAppFor: '0356' });
  assert.ok(!updates.some((u) => 'Nationality' in u), 'an existing Nationality must not be overwritten');
  assert.ok(!updates.some((u) => 'TeritoryAppFor' in u), 'an existing TeritoryAppFor must not be overwritten');
});
