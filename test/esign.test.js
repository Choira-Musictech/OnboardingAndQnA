// ==================================================================
// E-signing of the application form (node:test): the emSigner client, the signing service, the
// chat gate and the payment guard. emSigner, the database and PDF rendering are all stubbed -
// no network, no database, no browser. Run: npm test
// ==================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-test-'));
process.env.ESIGN_ENABLED = 'true';
process.env.EMSIGNER_RETURN_URL = 'https://backend.example/esign/emsigner/return';
process.env.EMSIGNER_INITIATOR_EMAIL = 'initiator@iprs.example';
process.env.DOCUSIGN_RETURN_URL = 'https://backend.example/esign/docusign/return';
process.env.ESIGN_STORAGE_DIR = STORAGE;

const { EmSignerClient } = await import('../src/modules/esign/services/emsigner.client.js');
const { esignService, esignProviders } = await import('../src/modules/esign/services/esign.service.js');
const { esignRepository } = await import('../src/modules/esign/repositories/esign.repository.js');
const { applicationPdfService } = await import('../src/modules/esign/services/applicationPdf.service.js');
const { registrationRepository } = await import('../src/modules/registration/repositories/registration.repository.js');
const { needsSignature } = await import('../src/modules/conversation/services/typebot/esignGate.js');
const { paymentService } = await import('../src/modules/payment/services/payment.service.js');
const { userRepository } = await import('../src/modules/user/repositories/user.repository.js');
const { paymentRepository } = await import('../src/modules/payment/repositories/payment.repository.js');

// --- emSigner client -------------------------------------------------------

function fakeJwt(expiresInSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64url');
  return `header.${payload}.sig`;
}

function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ path: new URL(url).pathname, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses[new URL(url).pathname];
    const body = typeof next === 'function' ? next() : next;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const AUTH_OK = () => ({ isSuccess: true, errorCode: 0, response: { authToken: fakeJwt(3600), refreshToken: 'r' } });
const INITIATE_OK = {
  isSuccess: true,
  errorCode: 2000,
  errorKey: 'URL_GENERATED',
  response: { workflowId: 71151, documentIdList: [161640], url: 'https://sign.example/External/Index?x=1' },
};

const client = (fetchImpl) =>
  new EmSignerClient({ baseUrl: 'https://emsigner.example/', appName: 'IPRS', secretKey: 'secret', environment: 'Development', timeoutMs: 1000, fetchImpl });

const SIGN_INPUT = {
  name: 'IPRS Application 1',
  initiatorEmail: 'initiator@iprs.example',
  signerEmail: 'member@example.com',
  redirectUrl: 'https://backend.example/esign/emsigner/return?esign=1',
  documentName: 'IPRS-Application-1.pdf',
  pdf: Buffer.from('%PDF-1.4 test'),
  signatureBox: { page: 3, left: 397, top: 425, width: 164, height: 62, pageHeight: 842 },
};

test('emSigner: authorizes once, then signs with the bearer token and the Aadhaar mode', async () => {
  const { calls, fetchImpl } = recordingFetch({
    '/api/Public/AuthorizeApp/authorize': AUTH_OK,
    '/api/Public/InitiateEmbeddedSigning': INITIATE_OK,
  });
  const emSigner = client(fetchImpl);

  const first = await emSigner.initiateSigning(SIGN_INPUT);
  await emSigner.initiateSigning(SIGN_INPUT);

  assert.deepEqual(first, { workflowId: '71151', documentId: '161640', url: INITIATE_OK.response.url, raw: first.raw });
  assert.equal(calls.filter((c) => c.path.endsWith('/authorize')).length, 1, 'the token is reused');
  assert.deepEqual(calls[0].body, { AppName: 'IPRS', SecretKey: 'secret' });

  const initiate = calls[1];
  assert.match(initiate.headers.Authorization, /^Bearer header\./);
  assert.equal(initiate.headers.Environment, 'Development');
  assert.deepEqual(initiate.body.SignatoryEmailIds, ['member@example.com']);
  assert.equal(initiate.body.SignatureSettings[0].ModeOfSignature, '12');
  assert.equal(initiate.body.RedirectURL, SIGN_INPUT.redirectUrl);
  const [doc] = initiate.body.lstDocumentDetails;
  assert.equal(Buffer.from(doc.FileData, 'base64').toString(), '%PDF-1.4 test');
  assert.deepEqual(doc.ControlDetails[0], {
    controlID: 4, page: 'Specify', pageNo: '3', left: 397, top: 417, width: 561, height: 355, assignedTo: 1, SignerType: 1,
  }, 'the box is sent as two corners measured from the bottom of the page');
});

test('emSigner: refused credentials and a refused signing are reported as provider errors', async () => {
  const refused = recordingFetch({ '/api/Public/AuthorizeApp/authorize': { isSuccess: false, errorCode: 4001, messages: ['Invalid'] } });
  await assert.rejects(client(refused.fetchImpl).initiateSigning(SIGN_INPUT), (err) => err.errorCode === 'ESIGN_PROVIDER_ERROR');

  const failed = recordingFetch({
    '/api/Public/AuthorizeApp/authorize': AUTH_OK,
    '/api/Public/InitiateEmbeddedSigning': { isSuccess: false, errorCode: 4063, messages: ['Invalid request'] },
  });
  await assert.rejects(client(failed.fetchImpl).initiateSigning(SIGN_INPUT), /could not start the signing/);
});

test('emSigner: reads the workflow status and decodes the signed PDF', async () => {
  const { fetchImpl } = recordingFetch({
    '/api/Public/AuthorizeApp/authorize': AUTH_OK,
    '/api/Public/GetWorkflowInfo/GetDocumentInfo': { isSuccess: true, errorCode: 0, response: { workflowStatus: 'Completed' } },
    '/api/Public/DownloadWorkFlowDocumentByWorkflowId/download-documents': {
      isSuccess: true,
      errorCode: 2010,
      errorKey: 'DL_DOWNLOAD_SUCCESS',
      response: {
        workflowId: 71151,
        fileList: [{ documentId: 161640, documentName: 'IPRS.pdf', base64FileData: Buffer.from('%PDF signed').toString('base64'), isAttachment: false }],
      },
    },
  });
  const emSigner = client(fetchImpl);
  assert.equal((await emSigner.getWorkflowStatus('71151')).status, 'Completed');
  assert.equal((await emSigner.downloadSignedPdf('71151')).toString(), '%PDF signed');
});

// --- signing service -------------------------------------------------------

let account;
let rows;
let provider;
let docuSign;
let savedDocuments;

beforeEach(() => {
  account = { AccountId: 20490n, AccountRegType: 'I', AccountEmail: 'member@example.com', AccountName: 'Test Member' };
  rows = [];
  savedDocuments = [];
  provider = {
    started: [],
    status: 'Pending',
    async initiateSigning(input) {
      this.started.push(input);
      return { workflowId: '71151', documentId: '161640', url: 'https://sign.example/x', raw: {} };
    },
    async getWorkflowStatus() {
      return { status: this.status, raw: {} };
    },
    async downloadSignedPdf() {
      return Buffer.from('%PDF signed');
    },
  };
  esignProviders.emSigner = provider;
  docuSign = {
    started: [],
    links: [],
    status: 'sent',
    async initiateSigning(input) {
      this.started.push(input);
      return { workflowId: 'env-1', documentId: '1', url: 'https://docusign.example/view-1', raw: {} };
    },
    async createSigningUrl(input) {
      this.links.push(input);
      return `https://docusign.example/view-${this.links.length + 1}`;
    },
    async getWorkflowStatus() {
      return { status: this.status, raw: {} };
    },
    async downloadSignedPdf() {
      return Buffer.from('%PDF docusign signed');
    },
  };
  esignProviders.docuSign = docuSign;

  registrationRepository.findByAccountId = async () => account;
  registrationRepository.upsertDocument = async (doc) => {
    savedDocuments.push(doc);
  };
  applicationPdfService.generate = async () => ({ pdf: Buffer.from('%PDF form'), data: { applicationNo: '20490' } });

  esignRepository.createSigning = async ({ accountId, provider: name, status }) => {
    const row = { ESignId: BigInt(rows.length + 1), AccountId: BigInt(accountId), Provider: name, Status: status, CreateDate: new Date() };
    rows.push(row);
    return row;
  };
  esignRepository.updateSigning = async (id, data) => {
    const row = rows.find((r) => r.ESignId === BigInt(id));
    Object.assign(row, data);
    return row;
  };
  esignRepository.findSigningById = async (id) => rows.find((r) => r.ESignId === BigInt(id)) ?? null;
  esignRepository.findLatestSigning = async () => rows.at(-1) ?? null;
  esignRepository.findCompletedSigning = async () => rows.filter((r) => r.Status === 'COMPLETED').at(-1) ?? null;
  esignRepository.hasCompletedSigning = async () => rows.some((r) => r.Status === 'COMPLETED');
});

test('starting a signing records it first, then sends the member to emSigner with our return URL', async () => {
  const result = await esignService.start('20490', { ip: '10.0.0.1' });

  assert.deepEqual(result, { status: 'INITIATED', signingUrl: 'https://sign.example/x' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ProviderRefId, '71151');
  assert.equal(rows[0].Provider, 'EMSIGNER');
  assert.equal(provider.started[0].redirectUrl, 'https://backend.example/esign/emsigner/return?esign=1');
  assert.equal(provider.started[0].signerEmail, 'member@example.com');
  assert.equal(provider.started[0].signatureBox.page, 3);
  assert.ok(fs.existsSync(path.resolve(rows[0].UnsignedPdfPath)), 'the unsigned form is kept');
});

test('an open signing link is reused, and a finished signing is not started again', async () => {
  await esignService.start('20490');
  await esignService.start('20490');
  assert.equal(provider.started.length, 1);

  rows[0].Status = 'COMPLETED';
  assert.deepEqual(await esignService.start('20490'), { status: 'COMPLETED', signingUrl: null });
});

test('a member with no membership type yet cannot start a signing', async () => {
  account.AccountRegType = null;
  assert.equal(await esignService.isRequired('20490'), false);
  await assert.rejects(esignService.start('20490'), /not available for this membership type/);
});

test('NRI members (NI / NC) sign with DocuSign, as an embedded signer with our return URL', async () => {
  for (const regType of ['NI', 'NC']) {
    rows = [];
    docuSign.started = [];
    account.AccountRegType = regType;
    assert.equal(await esignService.isRequired('20490'), true);
    assert.equal(await esignService.providerForUser('20490'), 'DOCUSIGN');

    const result = await esignService.start('20490');
    assert.deepEqual(result, { status: 'INITIATED', signingUrl: 'https://docusign.example/view-1' });
    assert.equal(rows[0].Provider, 'DOCUSIGN');
    assert.equal(rows[0].ProviderRefId, 'env-1');
    const [input] = docuSign.started;
    assert.equal(input.returnUrl, 'https://backend.example/esign/docusign/return?esign=1');
    assert.equal(input.clientUserId, '20490');
    assert.equal(input.signerName, 'Test Member');
    assert.equal(input.anchorText, 'sign_here');
    assert.equal(provider.started.length, 0, 'eMudhra is not used');
  }
});

test('an unfinished DocuSign envelope gets a fresh link, not a second envelope', async () => {
  account.AccountRegType = 'NI';
  await esignService.start('20490');
  docuSign.status = 'delivered';
  const again = await esignService.start('20490');

  assert.equal(docuSign.started.length, 1, 'one envelope');
  assert.equal(docuSign.links.length, 1);
  assert.equal(docuSign.links[0].envelopeId, 'env-1');
  assert.equal(docuSign.links[0].clientUserId, '20490', 'the link is for the same embedded signer');
  assert.deepEqual(again, { status: 'INITIATED', signingUrl: 'https://docusign.example/view-2' });
  assert.equal(rows[0].SigningUrl, 'https://docusign.example/view-2');
});

test('the DocuSign return is checked with DocuSign: completed saves the signed form, declined fails', async () => {
  account.AccountRegType = 'NC';
  await esignService.start('20490');
  assert.equal(await esignService.handleProviderReturn('1'), 'INITIATED', 'still out for signing');

  docuSign.status = 'completed';
  assert.equal(await esignService.handleProviderReturn('1'), 'COMPLETED');
  assert.ok(fs.readFileSync(path.resolve(rows[0].SignedPdfPath)).toString().startsWith('%PDF docusign signed'));
  assert.equal(savedDocuments[0].caption, 'SIGNED_APPLICATION');

  rows = [];
  docuSign.status = 'sent';
  await esignService.start('20490');
  docuSign.status = 'declined';
  assert.equal(await esignService.handleProviderReturn('1'), 'FAILED');
  docuSign.status = 'sent';
  await esignService.start('20490');
  assert.equal(docuSign.started.length, 3, 'a declined envelope is replaced by a new one');
});

test('a provider failure marks the attempt FAILED and is reported', async () => {
  provider.initiateSigning = async () => {
    throw new Error('emSigner down');
  };
  await assert.rejects(esignService.start('20490'), /emSigner down/);
  assert.equal(rows[0].Status, 'FAILED');
});

test('the return is checked with emSigner: pending stays open, completed saves the signed form', async () => {
  await esignService.start('20490');

  assert.equal(await esignService.handleProviderReturn('999'), 'UNKNOWN', 'a return we did not create is ignored');
  assert.equal(await esignService.handleProviderReturn('abc'), 'UNKNOWN');
  assert.equal(await esignService.handleProviderReturn('1'), 'INITIATED', 'still pending at emSigner');

  provider.status = 'Completed';
  assert.equal(await esignService.handleProviderReturn('1'), 'COMPLETED');
  assert.ok(fs.readFileSync(path.resolve(rows[0].SignedPdfPath)).toString().startsWith('%PDF signed'));
  assert.equal(savedDocuments[0].caption, 'SIGNED_APPLICATION');
  assert.equal(await esignService.isSigned('20490'), true);
});

test('an expired workflow becomes FAILED so the member can start again', async () => {
  await esignService.start('20490');
  provider.status = 'Expired';
  assert.equal(await esignService.handleProviderReturn('1'), 'FAILED');

  provider.status = 'Pending';
  await esignService.start('20490');
  assert.equal(provider.started.length, 2, 'a new workflow is started after a failed one');
});

test('an older signing that was completed counts even when a newer one is still open', async () => {
  await esignService.start('20490');
  rows[0].Status = 'FAILED';
  await esignService.start('20490');
  rows[0].Status = 'COMPLETED';

  assert.equal((await esignService.getStatus('20490')).status, 'COMPLETED');
  assert.deepEqual(await esignService.start('20490'), { status: 'COMPLETED', signingUrl: null });
  assert.equal(provider.started.length, 2, 'no third workflow');
});

test('the status call confirms an open signing with emSigner', async () => {
  await esignService.start('20490');
  provider.status = 'Completed';
  assert.deepEqual(await esignService.getStatus('20490'), {
    required: true,
    status: 'COMPLETED',
    provider: 'EMSIGNER',
    completedAt: rows[0].CompletedDate,
  });
});

// --- chat gate and payment guard ------------------------------------------

test('the chat asks for a signature only while the member has not signed - Indian or NRI', async () => {
  for (const regType of ['I', 'C', 'NI', 'NC']) {
    rows = [];
    account.AccountRegType = regType;
    assert.equal(await needsSignature('20490'), true, regType);
    rows.push({ ESignId: 1n, Status: 'COMPLETED' });
    assert.equal(await needsSignature('20490'), false, regType);
  }
});

test('payment cannot start before the application is signed - Indian or NRI', async () => {
  paymentRepository.hasSuccessfulPayment = async () => false;
  for (const regType of ['I', 'NI']) {
    userRepository.findById = async () => ({ ...account, AccountRegType: regType });
    await assert.rejects(
      paymentService.initiatePayment({ userId: '20490' }),
      (err) => err.errorCode === 'ESIGN_REQUIRED' && err.statusCode === 403,
      regType,
    );
  }
});
