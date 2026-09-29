// ==================================================================
// DocumentLookupId / DocFileName (node:test) - App_Accounts_Doc.DocumentLookupId is now populated
// with IPRS's real Doc_LookUp id, and DocFileName follows their MRU_<AccountId>_<DocumentLookupId>_
// N1_<filename> convention, wherever a confident (docType, path) match exists - see
// documentLookupMap.js's header for exactly which combos are deliberately left unmapped.
//
// Three layers:
//   1. DOC_LOOKUP_ID_BY_PATH - change-detector against the confirmed mapping table
//   2. resolveDocPathKey/buildDocFileName - pure, always run
//   3. saveDocument() end-to-end - needs SQL Server, skipped when it isn't reachable
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDocPathKey, buildDocFileName, buildAccountImagePath, registrationService } from '../src/modules/registration/services/registration.service.js';
import { DOC_LOOKUP_ID_BY_PATH } from '../src/modules/registration/services/documentLookupMap.js';
import { prisma } from '../src/shared/prisma.js';

// --- layer 1: change-detector for the confirmed mapping table --------------

test('DOC_LOOKUP_ID_BY_PATH holds the confirmed id for one representative docType per path', () => {
  assert.equal(DOC_LOOKUP_ID_BY_PATH.I.PAN, 1);
  assert.equal(DOC_LOOKUP_ID_BY_PATH.NI.PASSPORT, 30);
  assert.equal(DOC_LOOKUP_ID_BY_PATH.NC.REGISTERED_ADDRESS_PROOF, 71);
  assert.equal(DOC_LOOKUP_ID_BY_PATH.C_SP.TUM, 8);
  assert.equal(DOC_LOOKUP_ID_BY_PATH.C_PR.PARTNERSHIP_DEED, 86);
  assert.equal(DOC_LOOKUP_ID_BY_PATH.C_CP.MOA_AOA, 109);
});

test('COMPANY_NOC and NOC legitimately share the same C_CP id - MUPC2 has only one NOC row', () => {
  assert.equal(DOC_LOOKUP_ID_BY_PATH.C_CP.COMPANY_NOC, DOC_LOOKUP_ID_BY_PATH.C_CP.NOC);
});

// --- layer 2: pure logic -----------------------------------------------------

test('resolveDocPathKey derives the path key from AccountRegType/EntityType', () => {
  assert.equal(resolveDocPathKey({ AccountRegType: 'I' }), 'I');
  assert.equal(resolveDocPathKey({ AccountRegType: 'NI' }), 'NI');
  assert.equal(resolveDocPathKey({ AccountRegType: 'NC' }), 'NC');
  assert.equal(resolveDocPathKey({ AccountRegType: 'C', EntityType: 'SP' }), 'C_SP');
  assert.equal(resolveDocPathKey({ AccountRegType: 'C', EntityType: 'PR' }), 'C_PR');
  assert.equal(resolveDocPathKey({ AccountRegType: 'C', EntityType: 'CP' }), 'C_CP');
  assert.equal(resolveDocPathKey({ AccountRegType: 'C', EntityType: null }), null, 'entity type not yet answered - no confident path');
  assert.equal(resolveDocPathKey({ AccountRegType: 'unknown' }), null);
  assert.equal(resolveDocPathKey({}), null);
});

test('buildDocFileName adds the MRU_ prefix only when a real DocumentLookupId was resolved', () => {
  const url = 'https://s3.amazonaws.com/bucket/path/passbook.jpg';
  assert.equal(buildDocFileName('12768', 2, url), 'MRU_12768_2_N1_passbook.jpg');
});

test('buildDocFileName falls back to the plain filename when documentLookupId is null - unchanged today\'s behavior', () => {
  const url = 'https://s3.amazonaws.com/bucket/path/passbook.jpg';
  assert.equal(buildDocFileName('12768', null, url), 'passbook.jpg');
});

test('buildDocFileName returns null for a null documentUrl, same as extractFileName alone', () => {
  assert.equal(buildDocFileName('12768', 1, null), null);
});

test('buildDocFileName truncates the filename to fit the NVarChar(100) budget, prefix intact', () => {
  const longName = 'x'.repeat(150) + '.jpg';
  const url = `https://s3.amazonaws.com/bucket/path/${longName}`;
  const result = buildDocFileName('12768', 1, url);
  const prefix = 'MRU_12768_1_N1_';

  assert.ok(result.length <= 100, `expected <= 100 chars, got ${result.length}`);
  assert.ok(result.startsWith(prefix));
  assert.equal(result.length, 100);
  assert.equal(result.slice(prefix.length), longName.slice(0, 100 - prefix.length));
});

test('buildDocFileName at exactly 100 chars is not truncated; one char over is truncated by exactly 1', () => {
  const prefix = 'MRU_1_1_N1_';
  const exactName = 'a'.repeat(100 - prefix.length);
  const overName = exactName + 'b';

  const exact = buildDocFileName('1', 1, `https://s3.amazonaws.com/${exactName}`);
  const over = buildDocFileName('1', 1, `https://s3.amazonaws.com/${overName}`);

  assert.equal(exact.length, 100);
  assert.equal(exact, prefix + exactName);
  assert.equal(over.length, 100);
  assert.equal(over, prefix + exactName); // the extra "b" is the one character dropped
});

// --- buildAccountImagePath: pure logic ---------------------------------------

test('buildAccountImagePath follows the MemberPhoto/MPU_<AccountId>_<filename> prod convention', () => {
  const url = 'https://s3.amazonaws.com/bucket/path/photo.jpg';
  assert.equal(buildAccountImagePath('12768', url), 'MemberPhoto/MPU_12768_photo.jpg');
});

test('buildAccountImagePath returns null for a null documentUrl', () => {
  assert.equal(buildAccountImagePath('12768', null), null);
});

test('buildAccountImagePath normalizes hyphens in the original filename to underscores', () => {
  // Real filenames (WhatsApp exports, phone camera-roll names) commonly carry hyphens - IPRS's own
  // convention is underscores throughout, so the prefix and the filename should match.
  const url = 'https://s3.amazonaws.com/bucket/IMG-20260222-WA0027.jpg';
  assert.equal(buildAccountImagePath('15207', url), 'MemberPhoto/MPU_15207_IMG_20260222_WA0027.jpg');
});

test('buildAccountImagePath truncates the filename to fit the NVarChar(100) budget, prefix intact', () => {
  const longName = 'x'.repeat(150) + '.jpg';
  const url = `https://s3.amazonaws.com/bucket/path/${longName}`;
  const result = buildAccountImagePath('12768', url);
  const prefix = 'MemberPhoto/MPU_12768_';

  assert.ok(result.length <= 100, `expected <= 100 chars, got ${result.length}`);
  assert.ok(result.startsWith(prefix));
  assert.equal(result.length, 100);
});

// --- layer 3: saveDocument() end-to-end, driven against a real account -----

let dbAvailable = false;
const createdAccountIds = [];

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  for (const id of createdAccountIds) {
    await prisma.appAccountsDoc.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function makeAccount(data = {}) {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9100${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
      ...data,
    },
  });
  createdAccountIds.push(account.AccountId);
  return account;
}

test('saveDocument() on the Individual path writes the confirmed DocumentLookupId and DocFileName', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({ AccountRegType: 'I' });
  const userId = String(account.AccountId);

  await registrationService.saveDocument(userId, userId, 'PAN', 'https://s3.amazonaws.com/bucket/pan.jpg');

  const saved = await prisma.appAccountsDoc.findFirst({ where: { AccountId: account.AccountId, DocumentName: 'PAN' } });
  assert.equal(saved.DocumentLookupId, 1n);
  assert.equal(saved.DocFileName, `MRU_${userId}_1_N1_pan.jpg`);
});

test('saveDocument() on a docType with no confirmed mapping writes DocumentLookupId null and the plain filename', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({ AccountRegType: 'I' });
  const userId = String(account.AccountId);

  await registrationService.saveDocument(userId, userId, 'AADHAAR', 'https://s3.amazonaws.com/bucket/aadhaar.jpg');

  const saved = await prisma.appAccountsDoc.findFirst({ where: { AccountId: account.AccountId, DocumentName: 'AADHAAR' } });
  assert.equal(saved.DocumentLookupId, null);
  assert.equal(saved.DocFileName, 'aadhaar.jpg');
});

test('a re-upload overwrites DocumentLookupId and DocFileName rather than leaving them stale', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({ AccountRegType: 'C', EntityType: 'SP' });
  const userId = String(account.AccountId);

  await registrationService.saveDocument(userId, userId, 'BANK', 'https://s3.amazonaws.com/bucket/first.jpg');
  await registrationService.saveDocument(userId, userId, 'BANK', 'https://s3.amazonaws.com/bucket/second.jpg');

  const rows = await prisma.appAccountsDoc.findMany({ where: { AccountId: account.AccountId, DocumentName: 'BANK' } });
  assert.equal(rows.length, 1, 're-upload updates the existing row rather than creating a second one');
  assert.equal(rows[0].DocumentLookupId, 9n);
  assert.equal(rows[0].DocFileName, `MRU_${userId}_9_N1_second.jpg`);
});

test('saveDocument() on PROFILE_PHOTO also writes AppAccounts.AccountImage in the prod convention', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({ AccountRegType: 'I' });
  const userId = String(account.AccountId);

  await registrationService.saveDocument(userId, userId, 'PROFILE_PHOTO', 'https://s3.amazonaws.com/bucket/selfie.jpg');

  const saved = await prisma.appAccounts.findUnique({ where: { AccountId: account.AccountId }, select: { AccountImage: true } });
  assert.equal(saved.AccountImage, `MemberPhoto/MPU_${userId}_selfie.jpg`);
});

test('saveDocument() on a non-photo docType leaves AccountImage untouched', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({ AccountRegType: 'I' });
  const userId = String(account.AccountId);

  await registrationService.saveDocument(userId, userId, 'PAN', 'https://s3.amazonaws.com/bucket/pan.jpg');

  const saved = await prisma.appAccounts.findUnique({ where: { AccountId: account.AccountId }, select: { AccountImage: true } });
  assert.equal(saved.AccountImage, null);
});
