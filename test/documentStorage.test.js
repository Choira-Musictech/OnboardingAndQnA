// ==================================================================
// documentStorage.service.js - the per-member folder copy of each upload (node:test).
// Real filesystem in a throwaway temp folder, fake account lookup - no DB.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStorage } from '../src/modules/registration/services/documentStorage.service.js';

async function setup() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'member-docs-'));
  const accounts = new Map();
  const storage = createDocumentStorage({ baseDir, findAccount: async (id) => accounts.get(String(id)) ?? null });
  const save = (overrides) =>
    storage.saveMemberDocument({
      accountId: '17331',
      docType: 'PAN',
      addressProofType: null,
      buffer: Buffer.from('file'),
      originalName: 'scan.jpg',
      mimeType: 'image/jpeg',
      ...overrides,
    });
  const cleanup = () => rm(baseDir, { recursive: true, force: true });
  return { baseDir, accounts, save, cleanup };
}

const list = async (dir) => (await readdir(dir)).sort();

test('with no name on file yet, the document lands in a folder named by AccountId', async () => {
  const { baseDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'PROFILE_PHOTO' });
    assert.deepEqual(await list(baseDir), ['17331']);
    assert.deepEqual(await list(path.join(baseDir, '17331')), ['profile_photo.jpg']);
  } finally {
    await cleanup();
  }
});

test('once the name is known, the folder is renamed and earlier documents move with it', async () => {
  const { baseDir, accounts, save, cleanup } = await setup();
  try {
    await save({ docType: 'PROFILE_PHOTO' });
    accounts.set('17331', { AccountName: 'Swapnil Sharma' });
    await save({ docType: 'PAN' });

    assert.deepEqual(await list(baseDir), ['Swapnil_Sharma_17331']);
    assert.deepEqual(await list(path.join(baseDir, 'Swapnil_Sharma_17331')), ['pan_card.jpg', 'profile_photo.jpg']);
  } finally {
    await cleanup();
  }
});

test('a re-upload replaces the earlier copy, even with a different extension', async () => {
  const { baseDir, accounts, save, cleanup } = await setup();
  try {
    accounts.set('17331', { AccountName: 'Swapnil' });
    await save({ docType: 'BANK', originalName: 'cheque.jpg' });
    await save({ docType: 'BANK', originalName: 'cheque.pdf', mimeType: 'application/pdf' });

    assert.deepEqual(await list(path.join(baseDir, 'Swapnil_17331')), ['bank_cheque_or_passbook.pdf']);
  } finally {
    await cleanup();
  }
});

test('an address proof is named by its slot and the chosen type, and re-picking the type replaces it', async () => {
  const { baseDir, accounts, save, cleanup } = await setup();
  try {
    accounts.set('17331', { AccountName: 'Swapnil' });
    await save({ docType: 'PERMANENT_ADDRESS_PROOF', addressProofType: 'DRIVING_LICENCE' });
    assert.deepEqual(await list(path.join(baseDir, 'Swapnil_17331')), ['permanent_address_proof-driving_licence.jpg']);

    await save({ docType: 'PERMANENT_ADDRESS_PROOF', addressProofType: 'PASSPORT' });
    assert.deepEqual(await list(path.join(baseDir, 'Swapnil_17331')), ['permanent_address_proof-passport.jpg']);
  } finally {
    await cleanup();
  }
});

test('an address proof with no OCR-able type keeps just the slot name', async () => {
  const { baseDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'CURRENT_ADDRESS_PROOF', addressProofType: null });
    assert.deepEqual(await list(path.join(baseDir, '17331')), ['current_address_proof.jpg']);
  } finally {
    await cleanup();
  }
});

test('slots whose names share a prefix never replace each other', async () => {
  const { baseDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'COMM_ADDRESS_PROOF' });
    await save({ docType: 'COMM_ADDRESS_PROOF_2' });
    await save({ docType: 'COMM_ADDRESS_PROOF' });

    assert.deepEqual(await list(path.join(baseDir, '17331')), ['comm_address_proof.jpg', 'comm_address_proof_2.jpg']);
  } finally {
    await cleanup();
  }
});

test('a hostile name cannot climb out of the base folder', async () => {
  const { baseDir, accounts, save, cleanup } = await setup();
  try {
    accounts.set('17331', { AccountName: '../../etc/passwd' });
    const written = await save({ docType: 'PAN' });

    assert.deepEqual(await list(baseDir), ['etc_passwd_17331']);
    assert.ok(path.resolve(written).startsWith(path.resolve(baseDir) + path.sep));
  } finally {
    await cleanup();
  }
});

test('a non-numeric accountId is refused rather than used as a folder name', async () => {
  const { save, cleanup } = await setup();
  try {
    await assert.rejects(save({ accountId: '../x' }));
  } finally {
    await cleanup();
  }
});

test('a missing extension falls back to the MIME type', async () => {
  const { baseDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'PAN', originalName: 'scan', mimeType: 'image/png' });
    assert.deepEqual(await list(path.join(baseDir, '17331')), ['pan_card.png']);
  } finally {
    await cleanup();
  }
});

test('a blank base folder turns the copy off', async () => {
  const storage = createDocumentStorage({ baseDir: '', findAccount: async () => null });
  const written = await storage.saveMemberDocument({
    accountId: '17331',
    docType: 'PAN',
    buffer: Buffer.from('file'),
    originalName: 'scan.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(written, null);
});
