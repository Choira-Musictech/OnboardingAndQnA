// ==================================================================
// PAN type:p/c + DRIVING_LICENCE/PASSPORT/VOTER_ID/BANK holderName OCR params (node:test).
// Confirmed with the OCR team, not in the service's own Postman collection - see
// httpOcrProvider.js's NAME_VERIFIED_DOC_TYPES/panHolderType comments.
//
// Two layers, same convention as verifyProvider.test.js/identityNameMismatch.test.js:
//   1. httpOcrProvider posts the right { type }/{ name } fields - no DB, `fetch` mocked
//   2. saveDocument() computes panHolderType/holderName correctly from the account row - needs SQL
//      Server, skipped when it isn't reachable
// Run: npm test
// ==================================================================
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpOcrProvider } from '../src/modules/registration/services/ocr/httpOcrProvider.js';
import { env } from '../src/config/env.js';
import { registrationService, ocrProvider } from '../src/modules/registration/services/registration.service.js';
import { prisma } from '../src/shared/prisma.js';

const { saveDocument } = registrationService;

// --- layer 1: httpOcrProvider request body ----------------------------------

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

function mockFetch(handler) {
  global.fetch = async (url, options) => handler(url, options);
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('PAN with panHolderType "p" sends {documentUrl, type: "p"}', async () => {
  let seenBody;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, data: { isValid: true } });
  });

  const provider = createHttpOcrProvider();
  await provider.extract({ docType: 'PAN', documentUrl: 'https://s3.amazonaws.com/bucket/pan.jpg', panHolderType: 'p' });

  assert.deepEqual(seenBody, { documentUrl: 'https://s3.amazonaws.com/bucket/pan.jpg', type: 'p' });
});

test('PAN with panHolderType "c" sends {documentUrl, type: "c"}', async () => {
  let seenBody;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, data: { isValid: true } });
  });

  const provider = createHttpOcrProvider();
  await provider.extract({ docType: 'PAN', documentUrl: 'https://s3.amazonaws.com/bucket/pan.jpg', panHolderType: 'c' });

  assert.deepEqual(seenBody, { documentUrl: 'https://s3.amazonaws.com/bucket/pan.jpg', type: 'c' });
});

test('PAN with no panHolderType omits the type field entirely', async () => {
  let seenBody;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, data: { isValid: true } });
  });

  const provider = createHttpOcrProvider();
  await provider.extract({ docType: 'PAN', documentUrl: 'https://s3.amazonaws.com/bucket/pan.jpg' });

  assert.deepEqual(seenBody, { documentUrl: 'https://s3.amazonaws.com/bucket/pan.jpg' });
});

test('a non-PAN doc type never gets a type field, even if panHolderType is passed by mistake', async () => {
  let seenBody;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, data: { isValid: true } });
  });

  const provider = createHttpOcrProvider();
  await provider.extract({ docType: 'AADHAAR', documentUrl: 'https://s3.amazonaws.com/bucket/aadhaar.jpg', panHolderType: 'p' });

  assert.deepEqual(seenBody, { documentUrl: 'https://s3.amazonaws.com/bucket/aadhaar.jpg' });
});

for (const docType of ['DRIVING_LICENCE', 'PASSPORT', 'VOTER_ID', 'BANK']) {
  test(`${docType} with holderName sends {documentUrl, name}`, async () => {
    let seenBody;
    mockFetch(async (url, options) => {
      seenBody = JSON.parse(options.body);
      return jsonResponse(200, { status: true, data: { isValid: true } });
    });

    const provider = createHttpOcrProvider();
    await provider.extract({ docType, documentUrl: 'https://s3.amazonaws.com/bucket/doc.jpg', holderName: 'REAL NAME' });

    assert.deepEqual(seenBody, { documentUrl: 'https://s3.amazonaws.com/bucket/doc.jpg', name: 'REAL NAME' });
  });
}

test('BANK with no holderName sends name: "" instead of omitting the field', async () => {
  let seenBody;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, data: { isValid: true } });
  });

  const provider = createHttpOcrProvider();
  await provider.extract({ docType: 'BANK', documentUrl: 'https://s3.amazonaws.com/bucket/doc.jpg' });

  assert.deepEqual(seenBody, { documentUrl: 'https://s3.amazonaws.com/bucket/doc.jpg', name: '' });
});

for (const docType of ['AADHAAR', 'PAN']) {
  test(`${docType} never gets a name field, even if holderName is passed by mistake`, async () => {
    let seenBody;
    mockFetch(async (url, options) => {
      seenBody = JSON.parse(options.body);
      return jsonResponse(200, { status: true, data: { isValid: true } });
    });

    const provider = createHttpOcrProvider();
    await provider.extract({ docType, documentUrl: 'https://s3.amazonaws.com/bucket/doc.jpg', holderName: 'REAL NAME' });

    assert.equal('name' in seenBody, false);
  });
}

test('with OCR_NAME_VERIFICATION_ENABLED off, no NAME_VERIFIED_DOC_TYPES sends a name field at all', async (t) => {
  // env is frozen at process start (config/env.js) - can't be monkey-patched here, same limitation
  // as OCR_ENABLED/GST_VERIFY_ENABLED elsewhere. This self-skips unless .env has the flag
  // off locally, mirroring the pattern those tests use for their own kill-switches.
  if (env.OCR_NAME_VERIFICATION_ENABLED) return t.skip('OCR_NAME_VERIFICATION_ENABLED is true locally');

  let seenBody;
  mockFetch(async (url, options) => {
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, data: { isValid: true } });
  });

  const provider = createHttpOcrProvider();
  await provider.extract({ docType: 'BANK', documentUrl: 'https://s3.amazonaws.com/bucket/doc.jpg', holderName: 'REAL NAME' });

  assert.equal('name' in seenBody, false, 'the kill-switch stops the name field being sent even when a real holderName is available');
});

// --- layer 2: saveDocument() computes panHolderType/holderName from the account ----

let dbAvailable = false;
const createdAccountIds = [];
const originalExtract = ocrProvider.extract;

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  ocrProvider.extract = originalExtract;
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
      AccountMobile: `9500${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
      ...data,
    },
  });
  createdAccountIds.push(account.AccountId);
  return account;
}

test('an individual PAN upload calls ocrProvider.extract with panHolderType "p"', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is false locally');
  const account = await makeAccount({ AccountRegType: 'I' });
  const userId = String(account.AccountId);

  let seenArgs;
  ocrProvider.extract = async (args) => {
    seenArgs = args;
    return { isValid: true, pan: 'ABCDE1234F' };
  };
  await saveDocument(userId, userId, 'PAN', 'https://s3.amazonaws.com/bucket/pan.jpg');

  assert.equal(seenArgs.panHolderType, 'p');
});

test('a COMPANY_PAN upload (remapped to the PAN OCR type) calls ocrProvider.extract with panHolderType "c"', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is false locally');
  const account = await makeAccount({ AccountRegType: 'C', EntityType: 'CP' });
  const userId = String(account.AccountId);

  let seenArgs;
  ocrProvider.extract = async (args) => {
    seenArgs = args;
    return { isValid: true, pan: 'ABCDE1234F' };
  };
  await saveDocument(userId, userId, 'COMPANY_PAN', 'https://s3.amazonaws.com/bucket/pan.jpg');

  assert.equal(seenArgs.docType, 'PAN', 'COMPANY_PAN is remapped to the PAN OCR type');
  assert.equal(seenArgs.panHolderType, 'c');
});

test('a BANK upload calls ocrProvider.extract with holderName equal to the account\'s AccountName', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is false locally');
  const account = await makeAccount({ AccountRegType: 'I', AccountName: 'REAL NAME' });
  const userId = String(account.AccountId);

  let seenArgs;
  ocrProvider.extract = async (args) => {
    seenArgs = args;
    return { isValid: true, bankName: 'Test Bank' };
  };
  await saveDocument(userId, userId, 'BANK', 'https://s3.amazonaws.com/bucket/passbook.jpg');

  assert.equal(seenArgs.holderName, 'REAL NAME');
});

test('a BANK upload with no AccountName on file yet calls ocrProvider.extract with holderName undefined', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is false locally');
  const account = await makeAccount({ AccountRegType: 'I' });
  const userId = String(account.AccountId);

  let seenArgs;
  ocrProvider.extract = async (args) => {
    seenArgs = args;
    return { isValid: true, bankName: 'Test Bank' };
  };
  await saveDocument(userId, userId, 'BANK', 'https://s3.amazonaws.com/bucket/passbook.jpg');

  assert.equal(seenArgs.holderName, undefined);
});

for (const [label, regType] of [['a domestic company (C)', 'C'], ['an NRI company (NC)', 'NC']]) {
  test(`a BANK upload on ${label} account sends the company's own AccountName as holderName`, async (t) => {
    if (!dbAvailable) return t.skip('SQL Server is not reachable');
    if (!env.OCR_ENABLED) return t.skip('OCR_ENABLED is false locally');
    // AccountName on the C/NC paths holds the COMPANY's own name (from COMPANY_PAN's OCR), not a
    // person's - so it's correct to send it for the bank document's own name verification, same as
    // the individual path already does with its own AccountName.
    const account = await makeAccount({ AccountRegType: regType, EntityType: 'CP', AccountName: 'SOME COMPANY NAME' });
    const userId = String(account.AccountId);

    let seenArgs;
    ocrProvider.extract = async (args) => {
      seenArgs = args;
      return { isValid: true, bankName: 'Test Bank' };
    };
    await saveDocument(userId, userId, 'BANK', 'https://s3.amazonaws.com/bucket/passbook.jpg');

    assert.equal(seenArgs.holderName, 'SOME COMPANY NAME');
  });
}
