// ==================================================================
// documentStorage.service.js - the photo and document folder copies of each upload (node:test).
// Real filesystem in throwaway temp folders, fake account lookup - no DB.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStorage } from '../src/modules/registration/services/documentStorage.service.js';

const INDIVIDUAL = { AccountRegType: 'I' };

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'member-files-'));
  const photoDir = path.join(root, 'MemberPhoto');
  const documentDir = path.join(root, 'MemberDocuments');
  const accounts = new Map([['17331', INDIVIDUAL]]);
  const storage = createDocumentStorage({ photoDir, documentDir, findAccount: async (id) => accounts.get(String(id)) ?? null });
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
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { photoDir, documentDir, accounts, save, cleanup };
}

const list = async (dir) => (await readdir(dir).catch(() => [])).sort();

test('a document is named MRU_<AccountId>_<DocumentLookupId>_<uploaded name> in the documents folder', async () => {
  const { photoDir, documentDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'PAN', originalName: 'pan front.jpg' });
    await save({ docType: 'BANK', originalName: 'Cheque-1.pdf', mimeType: 'application/pdf' });
    assert.deepEqual(await list(documentDir), ['MRU_17331_1_pan front.jpg', 'MRU_17331_2_Cheque-1.pdf']);
    assert.deepEqual(await list(photoDir), []);
  } finally {
    await cleanup();
  }
});

test('the profile photo and a company photo go to the photos folder as MPU_<AccountId>_<uploaded name>', async () => {
  const { photoDir, documentDir, accounts, save, cleanup } = await setup();
  try {
    await save({ docType: 'PROFILE_PHOTO', originalName: 'IMG_2031.jpg' });
    accounts.set('500', { AccountRegType: 'NC' });
    await save({ accountId: '500', docType: 'COMPANY_PHOTO', originalName: 'office.png', mimeType: 'image/png' });
    assert.deepEqual(await list(photoDir), ['MPU_17331_IMG_2031.jpg', 'MPU_500_office.png']);
    assert.deepEqual(await list(documentDir), []);
  } finally {
    await cleanup();
  }
});

test('the number follows the member path: a Corporate company PAN is 91', async () => {
  const { documentDir, accounts, save, cleanup } = await setup();
  try {
    accounts.set('17331', { AccountRegType: 'C', EntityType: 'CP' });
    await save({ docType: 'COMPANY_PAN', originalName: 'cpan.jpg' });
    assert.deepEqual(await list(documentDir), ['MRU_17331_91_cpan.jpg']);
  } finally {
    await cleanup();
  }
});

test('a document with no Doc_LookUp number, or before the path is known, is named by its docType', async () => {
  const { documentDir, accounts, save, cleanup } = await setup();
  try {
    await save({ docType: 'GST', originalName: 'gst.pdf' });
    accounts.delete('17331');
    await save({ docType: 'PAN', originalName: 'pan.jpg' });
    assert.deepEqual(await list(documentDir), ['MRU_17331_GST_gst.pdf', 'MRU_17331_PAN_pan.jpg']);
  } finally {
    await cleanup();
  }
});

test('a company NOC and the NOC share id 95 but never replace each other', async () => {
  const { documentDir, accounts, save, cleanup } = await setup();
  try {
    accounts.set('17331', { AccountRegType: 'C', EntityType: 'CP' });
    await save({ docType: 'NOC', originalName: 'noc.pdf' });
    await save({ docType: 'COMPANY_NOC', originalName: 'company noc.pdf' });
    assert.deepEqual(await list(documentDir), ['MRU_17331_95_noc.pdf', 'MRU_17331_COMPANY_NOC_company noc.pdf']);
  } finally {
    await cleanup();
  }
});

test('a re-upload replaces only that slot, whatever the new file is called', async () => {
  const { photoDir, documentDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'PAN', originalName: 'old.jpg' });
    await save({ docType: 'BANK', originalName: 'bank.jpg' });
    await save({ docType: 'PROFILE_PHOTO', originalName: 'me.jpg' });
    await save({ docType: 'PAN', originalName: 'new.pdf', mimeType: 'application/pdf' });
    await save({ docType: 'PROFILE_PHOTO', originalName: 'me2.png', mimeType: 'image/png' });

    assert.deepEqual(await list(documentDir), ['MRU_17331_1_new.pdf', 'MRU_17331_2_bank.jpg']);
    assert.deepEqual(await list(photoDir), ['MPU_17331_me2.png']);
  } finally {
    await cleanup();
  }
});

test('another member whose id starts the same way is never touched', async () => {
  const { photoDir, documentDir, accounts, save, cleanup } = await setup();
  try {
    accounts.set('1733', INDIVIDUAL);
    await save({ docType: 'PAN', originalName: 'a.jpg' });
    await save({ docType: 'PROFILE_PHOTO', originalName: 'a.jpg' });
    await save({ accountId: '1733', docType: 'PAN', originalName: 'b.jpg' });
    await save({ accountId: '1733', docType: 'PROFILE_PHOTO', originalName: 'b.jpg' });

    assert.deepEqual(await list(documentDir), ['MRU_17331_1_a.jpg', 'MRU_1733_1_b.jpg']);
    assert.deepEqual(await list(photoDir), ['MPU_17331_a.jpg', 'MPU_1733_b.jpg']);
  } finally {
    await cleanup();
  }
});

test('slots named by docType where one extends the other never replace each other', async () => {
  const { documentDir, accounts, save, cleanup } = await setup();
  try {
    accounts.delete('17331');
    await save({ docType: 'COMM_ADDRESS_PROOF', originalName: 'one.jpg' });
    await save({ docType: 'COMM_ADDRESS_PROOF_2', originalName: 'two.jpg' });
    await save({ docType: 'COMM_ADDRESS_PROOF', originalName: 'three.jpg' });

    assert.deepEqual(await list(documentDir), ['MRU_17331_COMM_ADDRESS_PROOF_2_two.jpg', 'MRU_17331_COMM_ADDRESS_PROOF_three.jpg']);
  } finally {
    await cleanup();
  }
});

test('characters a file system cannot hold are replaced and a path in the name cannot escape', async () => {
  const { documentDir, save, cleanup } = await setup();
  try {
    const written = await save({ docType: 'PAN', originalName: '..\\..\\etc/pa:ss*?.jpg' });
    assert.deepEqual(await list(documentDir), ['MRU_17331_1_pa_ss__.jpg']);
    assert.ok(path.resolve(written).startsWith(path.resolve(documentDir) + path.sep));
  } finally {
    await cleanup();
  }
});

test('no uploaded name falls back to the docType and the MIME type', async () => {
  const { documentDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'PAN', originalName: '', mimeType: 'image/png' });
    assert.deepEqual(await list(documentDir), ['MRU_17331_1_pan.png']);
  } finally {
    await cleanup();
  }
});

test('a very long name is cut but keeps its extension', async () => {
  const { documentDir, save, cleanup } = await setup();
  try {
    await save({ docType: 'PAN', originalName: `${'x'.repeat(300)}.jpg` });
    const [name] = await list(documentDir);
    assert.equal(name.length, 200);
    assert.ok(name.startsWith('MRU_17331_1_') && name.endsWith('.jpg'));
  } finally {
    await cleanup();
  }
});

test('a non-numeric accountId is refused rather than used in a file name', async () => {
  const { save, cleanup } = await setup();
  try {
    await assert.rejects(save({ accountId: '../x' }));
  } finally {
    await cleanup();
  }
});

test('a blank folder turns that copy off', async () => {
  const storage = createDocumentStorage({ photoDir: '', documentDir: ' ', findAccount: async () => INDIVIDUAL });
  const base = { accountId: '17331', buffer: Buffer.from('file'), originalName: 'scan.jpg', mimeType: 'image/jpeg' };
  assert.equal(await storage.saveMemberDocument({ ...base, docType: 'PAN' }), null);
  assert.equal(await storage.saveMemberDocument({ ...base, docType: 'PROFILE_PHOTO' }), null);
});
