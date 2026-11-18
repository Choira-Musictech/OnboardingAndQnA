// ==================================================================
// Chat uploads kept on this server (uploadStorage.js), the public /uploads route, and the signed
// /documents route reading such an upload from disk. No DB (the document lookup is stubbed), no
// network beyond this app on a random local port. Run: npm test
// ==================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-uploads-'));
process.env.UPLOAD_DIR = DIR;
process.env.DOCUMENT_LINK_BASE_URL = 'http://localhost:4999';

const { uploadStorage, storedFileName } = await import('../src/modules/conversation/services/flow/uploadStorage.js');
const { typebotClient } = await import('../src/modules/conversation/services/typebot/typebotClient.js');
const { flowEngine } = await import('../src/modules/conversation/services/flow/flowEngine.js');
const { buildDocumentUrl } = await import('../src/modules/documents/services/documentLink.service.js');
const { registrationRepository } = await import('../src/modules/registration/repositories/registration.repository.js');
const { app } = await import('../src/app.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

async function upload(fileName, bytes = Buffer.from('%PDF-1.4 test')) {
  const { sessionId } = await flowEngine.startChat();
  const reserved = await typebotClient.generateUploadUrl({ sessionId, blockId: 'b', fileName, fileType: 'application/pdf', fileSize: bytes.length });
  await typebotClient.uploadToPresignedUrl({ ...reserved, fileBuffer: bytes, fileName, fileType: 'application/pdf' });
  return reserved;
}

test('an upload is kept on disk and its link ends in the file name', async () => {
  const { fileUrl } = await upload('pan.pdf');
  assert.match(fileUrl, /^http:\/\/localhost:4999\/uploads\/[a-f0-9]{32}\/pan\.pdf$/);
  const local = uploadStorage.localPathForUrl(fileUrl);
  assert.ok(local.startsWith(DIR));
  assert.equal(fs.readFileSync(local, 'utf8'), '%PDF-1.4 test');
});

test('the link serves the file, inline, readable from the chat\'s origin', async () => {
  const { fileUrl } = await upload('bank.pdf');
  const res = await fetch(fileUrl.replace('http://localhost:4999', base));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(await res.text(), '%PDF-1.4 test');
});

test('unknown tokens, made-up names and path tricks get a 404', async () => {
  const { fileUrl } = await upload('photo.jpg');
  const token = fileUrl.split('/').at(-2);
  for (const url of [
    `${base}/uploads/${'0'.repeat(32)}/photo.jpg`,
    `${base}/uploads/${token}/other.jpg`,
    `${base}/uploads/not-a-token/photo.jpg`,
    `${base}/uploads/${token}/..%2F..%2Fpackage.json`,
  ]) {
    assert.equal((await fetch(url)).status, 404, url);
  }
});

test('file names are made safe for a path and a URL', () => {
  assert.equal(storedFileName('Copy of Choira PAN.jpeg'), 'Copy_of_Choira_PAN.jpeg');
  assert.equal(storedFileName('../../etc/passwd'), 'passwd');
  assert.equal(storedFileName('.env'), 'env');
  assert.equal(storedFileName(''), 'file');
});

test('an upload for a chat session that does not exist is refused as a dead session', async () => {
  await assert.rejects(
    typebotClient.generateUploadUrl({ sessionId: 'gone', blockId: 'b', fileName: 'a.pdf' }),
    (err) => err.statusCode === 400 && /can't find session/i.test(err.message),
  );
});

test('a signed document link reads a local upload from disk', async () => {
  const { fileUrl } = await upload('aadhaar.pdf', Buffer.from('%PDF-1.4 aadhaar'));
  const doc = { AccountDocId: 77n, DocumentCaption: fileUrl, DocFileName: 'aadhaar.pdf' };
  const real = registrationRepository.findDocumentById;
  registrationRepository.findDocumentById = async (id) => (String(id) === '77' ? doc : null);
  try {
    const link = buildDocumentUrl(doc);
    assert.ok(link, 'a link is minted for a local upload');
    const res = await fetch(link.replace(/^https?:\/\/[^/]+/, base));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(await res.text(), '%PDF-1.4 aadhaar');
  } finally {
    registrationRepository.findDocumentById = real;
  }
});
