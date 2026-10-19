// ==================================================================
// DocuSign client (node:test): JWT grant, envelope + embedded signer, signing link, status and the
// signed PDF. fetch is stubbed and the RSA key is generated here - no network, no real credentials.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const { DocuSignClient } = await import('../src/modules/esign/services/docusign.client.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const BASE = 'https://demo.docusign.example/restapi';
const ACCOUNT = 'acct-1';

function recordingFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push({ url, pathname, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const handler = handlers[pathname];
    if (!handler) return new Response('{}', { status: 404 });
    const { status = 200, json, bytes } = typeof handler === 'function' ? handler() : handler;
    if (bytes) return new Response(bytes, { status, headers: { 'content-type': 'application/pdf' } });
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const TOKEN_OK = { json: { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 } };
const ENVELOPES = `/restapi/v2.1/accounts/${ACCOUNT}/envelopes`;

const client = (fetchImpl) =>
  new DocuSignClient({
    integrationKey: 'ik-1',
    userId: 'user-1',
    accountId: ACCOUNT,
    authServer: 'account-d.docusign.example',
    basePath: BASE,
    privateKey,
    timeoutMs: 1000,
    fetchImpl,
  });

const SIGN_INPUT = {
  name: 'IPRS Application 1',
  signerEmail: 'nri@example.com',
  signerName: 'NRI Member',
  clientUserId: '20490',
  returnUrl: 'https://backend.example/esign/docusign/return?esign=1',
  documentName: 'IPRS-Application-1.pdf',
  pdf: Buffer.from('%PDF-1.4 test'),
};

test('DocuSign: JWT grant as IPRS user, signed RS256, token reused across calls', async () => {
  const { calls, fetchImpl } = recordingFetch({
    '/oauth/token': TOKEN_OK,
    [ENVELOPES]: { status: 201, json: { envelopeId: 'env-1', status: 'sent' } },
    [`${ENVELOPES}/env-1/views/recipient`]: { status: 201, json: { url: 'https://docusign.example/signing/1' } },
  });
  const docuSign = client(fetchImpl);

  await docuSign.initiateSigning(SIGN_INPUT);
  await docuSign.initiateSigning(SIGN_INPUT);

  const tokenCalls = calls.filter((c) => c.pathname === '/oauth/token');
  assert.equal(tokenCalls.length, 1, 'the token is reused');
  assert.equal(tokenCalls[0].url, 'https://account-d.docusign.example/oauth/token');
  const form = new URLSearchParams(tokenCalls[0].body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

  const claims = jwt.verify(form.get('assertion'), publicKey, { algorithms: ['RS256'] });
  assert.equal(claims.iss, 'ik-1');
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.aud, 'account-d.docusign.example');
  assert.equal(claims.scope, 'signature impersonation');

  const envelopeCall = calls.find((c) => c.pathname === ENVELOPES);
  assert.equal(envelopeCall.headers.Authorization, 'Bearer access-1');
});

test('DocuSign: the envelope carries the PDF and one embedded signer placed by the sign_here anchor', async () => {
  const { calls, fetchImpl } = recordingFetch({
    '/oauth/token': TOKEN_OK,
    [ENVELOPES]: { status: 201, json: { envelopeId: 'env-1', status: 'sent' } },
    [`${ENVELOPES}/env-1/views/recipient`]: { status: 201, json: { url: 'https://docusign.example/signing/1' } },
  });

  const result = await client(fetchImpl).initiateSigning(SIGN_INPUT);
  assert.deepEqual(result, { workflowId: 'env-1', documentId: '1', url: 'https://docusign.example/signing/1', raw: result.raw });

  const envelope = JSON.parse(calls.find((c) => c.pathname === ENVELOPES).body);
  assert.equal(envelope.status, 'sent');
  assert.equal(Buffer.from(envelope.documents[0].documentBase64, 'base64').toString(), '%PDF-1.4 test');
  const [signer] = envelope.recipients.signers;
  assert.equal(signer.email, 'nri@example.com');
  assert.equal(signer.name, 'NRI Member');
  assert.equal(signer.clientUserId, '20490', 'embedded: DocuSign sends no email, the member signs in our flow');
  assert.equal(signer.tabs.signHereTabs[0].anchorString, 'sign_here');

  const view = JSON.parse(calls.find((c) => c.pathname.endsWith('/views/recipient')).body);
  assert.deepEqual(view, {
    returnUrl: SIGN_INPUT.returnUrl,
    authenticationMethod: 'none',
    email: 'nri@example.com',
    userName: 'NRI Member',
    clientUserId: '20490',
  }, 'the link is for the same signer the envelope was made for');
});

test('DocuSign: missing consent is reported as "not set up", other refusals as provider errors', async () => {
  const noConsent = recordingFetch({ '/oauth/token': { status: 400, json: { error: 'consent_required' } } });
  await assert.rejects(
    client(noConsent.fetchImpl).initiateSigning(SIGN_INPUT),
    (err) => err.errorCode === 'ESIGN_NOT_CONFIGURED' && err.statusCode === 503,
  );

  const refused = recordingFetch({
    '/oauth/token': TOKEN_OK,
    [ENVELOPES]: { status: 400, json: { errorCode: 'INVALID_REQUEST_BODY', message: 'bad' } },
  });
  await assert.rejects(client(refused.fetchImpl).initiateSigning(SIGN_INPUT), (err) => err.errorCode === 'ESIGN_PROVIDER_ERROR');
});

test('DocuSign: an unconfigured client never calls out', async () => {
  const { calls, fetchImpl } = recordingFetch({});
  const unconfigured = new DocuSignClient({ integrationKey: '', userId: '', accountId: '', basePath: BASE, privateKey, fetchImpl });
  await assert.rejects(unconfigured.getWorkflowStatus('env-1'), (err) => err.errorCode === 'ESIGN_NOT_CONFIGURED');
  assert.equal(calls.length, 0);
});

test('DocuSign: reads the envelope status and downloads the combined signed PDF', async () => {
  const { calls, fetchImpl } = recordingFetch({
    '/oauth/token': TOKEN_OK,
    [`${ENVELOPES}/env-1`]: { json: { envelopeId: 'env-1', status: 'completed', completedDateTime: '2026-10-17T10:00:00Z' } },
    [`${ENVELOPES}/env-1/documents/combined`]: { bytes: Buffer.from('%PDF signed') },
  });
  const docuSign = client(fetchImpl);

  assert.equal((await docuSign.getWorkflowStatus('env-1')).status, 'completed');
  assert.equal((await docuSign.downloadSignedPdf('env-1')).toString(), '%PDF signed');
  assert.equal(calls.find((c) => c.pathname.endsWith('/combined')).headers.Accept, 'application/pdf');
});

test('DocuSign: a rejected token is dropped and asked for again on the next call', async () => {
  let statusCalls = 0;
  const { calls, fetchImpl } = recordingFetch({
    '/oauth/token': TOKEN_OK,
    [`${ENVELOPES}/env-1`]: () => {
      statusCalls += 1;
      return statusCalls === 1 ? { status: 401, json: { errorCode: 'USER_AUTHENTICATION_FAILED' } } : { json: { status: 'sent' } };
    },
  });
  const docuSign = client(fetchImpl);

  await assert.rejects(docuSign.getWorkflowStatus('env-1'));
  assert.equal((await docuSign.getWorkflowStatus('env-1')).status, 'sent');
  assert.equal(calls.filter((c) => c.pathname === '/oauth/token').length, 2);
});
