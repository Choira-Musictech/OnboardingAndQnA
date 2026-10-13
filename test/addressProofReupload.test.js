// ==================================================================
// Address-proof reupload keeps its OCR type (node:test).
//
// Reported live: Owner/Publisher - Corporate flow, "Electricity/Light Bill"
// address proof. First upload extracts and shows OCR data as expected; tap
// "No, re-upload" and upload again, and the second attempt shows nothing -
// the conversation just advances as if OCR never ran.
//
// Root cause: `addressProofOcrType` is recorded on the Typebot session only
// once, right after the paired type-choice question. Every later
// typebotSessionStore.set() on the OCR-confirmation/reupload cycle replaced
// the whole session object without carrying it forward, so by the second
// handleUpload() call session.addressProofOcrType was gone. saveDocument()
// then fell back to the generic doc type (PERMANENT_ADDRESS_PROOF etc.),
// which isn't an OCR type, so OCR was silently skipped.
//
// This file monkey-patches the Typebot client and registrationService
// singletons. node:test runs each file in its own process, so that stays
// contained here.
// Run: npm test
// ==================================================================
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { registrationService } from '../src/modules/registration/services/registration.service.js';
import { documentStorageService } from '../src/modules/registration/services/documentStorage.service.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { handle, handleUpload } from '../src/modules/conversation/engines/registrationEngine.js';
import { prisma } from '../src/shared/prisma.js';

const USER = '999998';

// Real file-input block for an address-proof upload (see documentTypeMap.js -
// vxcy6e9zfnimssygpdw7v4wen -> PERMANENT_ADDRESS_PROOF).
const UPLOAD_INPUT = {
  id: 'address-upload-block',
  type: 'file input',
  options: { variableId: 'vxcy6e9zfnimssygpdw7v4wen' },
};

const OCR_EXTRACTED = { name: 'Jane Doe', address: '123 Main St' };

let saveDocumentCalls;

let confirmCalls;
function stubConfirmDocument() {
  confirmCalls = [];
  registrationService.confirmDocument = async (userId, registrationId, details) => {
    confirmCalls.push(details);
  };
}

function stubSaveDocument() {
  saveDocumentCalls = [];
  registrationService.saveDocument = async (createdBy, accountId, docType, fileUrl, ocrDocType, options) => {
    saveDocumentCalls.push({ docType, ocrDocType, options });
    // Mirrors registration.service.js: the `extracted` key only appears when OCR actually ran -
    // ocrDocType missing means it fell back to a generic docType that isn't an OCR type.
    if (!ocrDocType) return { id: saveDocumentCalls.length, docType };
    return { id: saveDocumentCalls.length, docType, extracted: OCR_EXTRACTED, verified: false };
  };
}

let uploadCount;
function stubUploadPlumbing() {
  uploadCount = 0;
  typebotClient.generateUploadUrl = async () => {
    uploadCount += 1;
    return { presignedUrl: 'https://s3/presigned', formData: {}, fileUrl: `https://s3/file-${uploadCount}.jpg` };
  };
  typebotClient.uploadToPresignedUrl = async () => {};
  // Otherwise every run writes this fake member's file into the real DOCUMENT_STORAGE_DIR.
  documentStorageService.saveMemberDocument = async () => null;
}

const FILE = { originalname: 'bill.jpg', mimetype: 'image/jpeg', size: 1000, buffer: Buffer.from('x') };

beforeEach(async () => {
  typebotSessionStore.clear(USER);
  await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: BigInt(USER) } }).catch(() => {});
  stubUploadPlumbing();
  stubSaveDocument();
  stubConfirmDocument();
  // "Yes, confirm" relays the file to Typebot - a fake next question.
  typebotClient.continueChat = async () => ({ input: { id: 'next-question', type: 'text input', options: {} }, messages: [] });
});

after(async () => {
  await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: BigInt(USER) } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
});

test('a reupload after "No, re-upload" still extracts and shows OCR data', async () => {
  // The address-proof type-choice question ('Electricity/Light Bill') has already run and stashed
  // addressProofOcrType alongside the upload block - exactly the session shape handle() produces.
  typebotSessionStore.set(USER, { sessionId: 'live-session', input: UPLOAD_INPUT, addressProofOcrType: 'ELECTRICITY' });

  const first = await handleUpload({ userId: USER, token: 't', file: FILE });
  assert.equal(saveDocumentCalls[0].ocrDocType, 'ELECTRICITY', 'first upload ran OCR');
  assert.equal(first.input.id, 'ocr-confirmation', 'first upload shows the OCR-confirmation card');
  assert.deepEqual(first.input.items?.map((i) => i.id), ['ocr-confirm-yes', 'ocr-confirm-no']);

  // Member taps "No, re-upload".
  const rejected = await handle({ userId: USER, token: 't', message: 'No, re-upload' });
  assert.equal(rejected.input.id, UPLOAD_INPUT.id, 'back on the same upload question');

  // Second upload attempt - this is the reported bug: without the fix, addressProofOcrType was lost
  // on the reject branch, so this call's ocrDocType would be undefined and OCR would be skipped.
  const second = await handleUpload({ userId: USER, token: 't', file: FILE });
  assert.equal(saveDocumentCalls[1].ocrDocType, 'ELECTRICITY', 'second upload still runs OCR');
  assert.equal(second.input.id, 'ocr-confirmation', 'second upload also shows the OCR-confirmation card');
  assert.equal(
    JSON.stringify(second.messages).includes('Jane Doe'),
    true,
    'the extracted data is shown, not skipped straight to the next question',
  );
});

// --- nothing is saved until the member confirms ------------------------------

test('the chat asks saveDocument to hold everything until the member confirms', async () => {
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'ELECTRICITY' });
  await handleUpload({ userId: USER, token: 't', file: FILE });
  assert.deepEqual(saveDocumentCalls[0].options, { deferUntilConfirmed: true });
});

test('"No, re-upload" saves nothing from the rejected document', async () => {
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'ELECTRICITY' });
  await handleUpload({ userId: USER, token: 't', file: FILE });
  await handle({ userId: USER, token: 't', message: 'No, re-upload' });
  assert.equal(confirmCalls.length, 0);
});

test('"Yes, confirm" saves the document with what OCR read, then moves on', async () => {
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'ELECTRICITY' });
  await handleUpload({ userId: USER, token: 't', file: FILE });

  const confirmed = await handle({ userId: USER, token: 't', message: 'Yes, confirm' });
  assert.equal(confirmCalls.length, 1);
  assert.deepEqual(confirmCalls[0], {
    docType: 'PERMANENT_ADDRESS_PROOF',
    documentUrl: 'https://s3/file-1.jpg',
    ocrDocType: 'ELECTRICITY',
    extracted: OCR_EXTRACTED,
  });
  assert.equal(confirmed.input.id, 'next-question');
});

test('if saving the confirmed document fails, the member stays on the upload', async () => {
  registrationService.confirmDocument = async () => { throw new Error('db down'); };
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'ELECTRICITY' });
  await handleUpload({ userId: USER, token: 't', file: FILE });

  const result = await handle({ userId: USER, token: 't', message: 'Yes, confirm' });
  assert.equal(result.input.id, UPLOAD_INPUT.id);
});

// --- switching document after an OCR failure --------------------------------

const OPTIONS = ['Passport', 'Driving Licence', 'Voter ID', 'Electricity/Light Bill', 'Letter from Property Owner'];

// OCR runs and fails for the first upload; any later one reads fine.
function stubFailThenSucceed() {
  saveDocumentCalls = [];
  registrationService.saveDocument = async (createdBy, accountId, docType, fileUrl, ocrDocType) => {
    saveDocumentCalls.push({ docType, ocrDocType });
    if (!ocrDocType) return { id: saveDocumentCalls.length, docType };
    if (saveDocumentCalls.length === 1) {
      return { id: 1, docType, extracted: null, verified: false, failureReason: 'This is not a passport.' };
    }
    return { id: saveDocumentCalls.length, docType, extracted: OCR_EXTRACTED, verified: true };
  };
}

test('an OCR failure on an address proof offers to upload again or choose a different document', async () => {
  stubFailThenSucceed();
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'PASSPORT', addressProofOptions: OPTIONS });

  const failed = await handleUpload({ userId: USER, token: 't', file: FILE });
  assert.equal(failed.input.id, 'address-proof-retry');
  assert.deepEqual(failed.input.items.map((item) => item.content), ['Upload again', 'Choose a different document']);
  assert.match(JSON.stringify(failed.messages), /This is not a passport/, 'the failure reason is still shown');
});

test('"Upload again" goes back to the same upload with the same document type', async () => {
  stubFailThenSucceed();
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'PASSPORT', addressProofOptions: OPTIONS });
  await handleUpload({ userId: USER, token: 't', file: FILE });

  const again = await handle({ userId: USER, token: 't', message: 'Upload again' });
  assert.equal(again.input.id, UPLOAD_INPUT.id);
  assert.equal(typebotSessionStore.get(USER).addressProofOcrType, 'PASSPORT');
});

test('choosing a different document switches the OCR type for the next upload', async () => {
  stubFailThenSucceed();
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'PASSPORT', addressProofOptions: OPTIONS });
  await handleUpload({ userId: USER, token: 't', file: FILE });

  const pickList = await handle({ userId: USER, token: 't', message: 'Choose a different document' });
  assert.equal(pickList.input.id, 'address-proof-pick');
  const offered = pickList.input.items.map((item) => item.content);
  assert.ok(!offered.includes('Passport'), 'the document that just failed is not offered again');
  assert.ok(offered.includes('Driving Licence'));

  const picked = await handle({ userId: USER, token: 't', message: 'Driving Licence' });
  assert.equal(picked.input.id, UPLOAD_INPUT.id, 'back on the same upload - Typebot never moved');
  assert.equal(typebotSessionStore.get(USER).addressProofOcrType, 'DRIVING_LICENCE');

  const second = await handleUpload({ userId: USER, token: 't', file: FILE });
  assert.equal(saveDocumentCalls[1].ocrDocType, 'DRIVING_LICENCE', 'the new document is read as a driving licence');
  assert.equal(second.input.id, 'ocr-confirmation');
});

test('with no captured option list, a failure keeps today\'s plain re-upload', async () => {
  stubFailThenSucceed();
  typebotSessionStore.set(USER, { sessionId: 's', input: UPLOAD_INPUT, addressProofOcrType: 'PASSPORT' });

  const failed = await handleUpload({ userId: USER, token: 't', file: FILE });
  assert.equal(failed.input.id, UPLOAD_INPUT.id);
});

test('the reject branch preserves addressProofOcrType in the stored session, not just the response', async () => {
  typebotSessionStore.set(USER, { sessionId: 'live-session', input: UPLOAD_INPUT, addressProofOcrType: 'ELECTRICITY' });
  await handleUpload({ userId: USER, token: 't', file: FILE });

  await handle({ userId: USER, token: 't', message: 'No, re-upload' });

  assert.equal(
    typebotSessionStore.get(USER).addressProofOcrType,
    'ELECTRICITY',
    'the session written by the reject branch still carries the OCR type forward',
  );
});
