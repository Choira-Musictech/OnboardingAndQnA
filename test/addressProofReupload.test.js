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

function stubSaveDocument() {
  saveDocumentCalls = [];
  registrationService.saveDocument = async (createdBy, accountId, docType, fileUrl, ocrDocType) => {
    saveDocumentCalls.push({ docType, ocrDocType });
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
