// ==================================================================
// Nothing from an OCR'd document is saved until the member confirms it (node:test).
//
// Reported live: a member uploaded someone else's PAN, tapped "No, re-upload" and uploaded their
// own - but the first PAN's name had already been written as AccountName (write-once), so their own
// passbook later failed the bank OCR's name check against the wrong person.
//
// Repository, OCR provider and env are stubbed in memory - no DB, no network.
// Run: npm test
// ==================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registrationService, ocrProvider } from '../src/modules/registration/services/registration.service.js';
import { registrationRepository } from '../src/modules/registration/repositories/registration.repository.js';
import { env } from '../src/config/env.js';

const USER = '55501';
let account;
let writes;
let rows;
let extractCalls;

const PAN_OF = {
  'https://s3/someone-else.jpg': { name: 'SOMEONE ELSE', pan: 'AAAAA1111A', isValid: true },
  'https://s3/mine.jpg': { name: 'UDAY SINGH', pan: 'BBBBB2222B', isValid: true },
};

beforeEach(() => {
  account = { AccountId: BigInt(USER), AccountRegType: 'I', AccountName: null };
  writes = [];
  rows = [];
  extractCalls = [];

  registrationRepository.findByAccountId = async () => ({ ...account });
  registrationRepository.update = async (_id, data) => {
    writes.push(data);
    Object.assign(account, data);
  };
  registrationRepository.upsertDocument = async (data) => {
    rows.push(data);
    return { AccountId: BigInt(USER), DocumentName: data.caption, DocumentCaption: data.documentUrl };
  };
  ocrProvider.extract = async ({ docType, documentUrl, holderName }) => {
    extractCalls.push({ docType, holderName });
    return docType === 'BANK' ? { bankName: 'UNION BANK', isValid: true } : PAN_OF[documentUrl];
  };
});

test('the chat\'s upload writes nothing - no account field, no document row', async (t) => {
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is off');
  const result = await registrationService.saveDocument(USER, USER, 'PAN', 'https://s3/someone-else.jpg', undefined, { deferUntilConfirmed: true });

  assert.equal(result.extracted.name, 'SOMEONE ELSE', 'the card still has what OCR read');
  assert.deepEqual(writes, []);
  assert.deepEqual(rows, []);
});

test('confirming saves what OCR read and the document row', async (t) => {
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is off');
  const { extracted } = await registrationService.saveDocument(USER, USER, 'PAN', 'https://s3/mine.jpg', undefined, { deferUntilConfirmed: true });

  await registrationService.confirmDocument(USER, USER, { docType: 'PAN', documentUrl: 'https://s3/mine.jpg', extracted });

  assert.equal(account.AccountName, 'UDAY SINGH');
  assert.equal(account.Detail2, 'BBBBB2222B');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caption, 'PAN');
  assert.equal(rows[0].ocrStatus, 0);
});

test('a rejected wrong PAN leaves no trace - the bank check uses the confirmed PAN\'s name', async (t) => {
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is off');
  // Someone else's PAN, shown on the card, rejected - so never confirmed.
  await registrationService.saveDocument(USER, USER, 'PAN', 'https://s3/someone-else.jpg', undefined, { deferUntilConfirmed: true });

  // Their own PAN, confirmed.
  const { extracted } = await registrationService.saveDocument(USER, USER, 'PAN', 'https://s3/mine.jpg', undefined, { deferUntilConfirmed: true });
  await registrationService.confirmDocument(USER, USER, { docType: 'PAN', documentUrl: 'https://s3/mine.jpg', extracted });
  assert.equal(account.AccountName, 'UDAY SINGH');

  // Their passbook is checked against their own name, not the rejected one.
  await registrationService.saveDocument(USER, USER, 'BANK', 'https://s3/passbook.jpg', undefined, { deferUntilConfirmed: true });
  assert.equal(extractCalls.at(-1).holderName, 'UDAY SINGH');
});

test('the REST route (no confirmation step) still saves straight away', async (t) => {
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is off');
  await registrationService.saveDocument(USER, USER, 'PAN', 'https://s3/mine.jpg');

  assert.equal(account.AccountName, 'UDAY SINGH');
  assert.equal(rows.length, 1);
});

test('a document with no OCR is saved straight away even from the chat', async () => {
  await registrationService.saveDocument(USER, USER, 'NOC', 'https://s3/noc.pdf', undefined, { deferUntilConfirmed: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ocrStatus, 1);
});
