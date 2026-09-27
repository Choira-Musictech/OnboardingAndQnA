// ==================================================================
// The GSTIN verify provider (node:test) - no DB, no network, `fetch` is
// monkey-patched for the duration of each test.
//
// The property worth pinning hard: PASS/FAIL IS DECIDED BY THE RESPONSE'S
// TOP-LEVEL `status` FIELD - the real API has no `success`/`verified` field
// at all, only `status` (boolean), same shape as the document OCR
// endpoints. A live probe returned `{ status: false, message: "Invalid
// GSTIN", data: null }` for a wrong GSTIN and `{ status: true, message:
// "GSTIN verified successfully", data: {...} }` for a valid one.
// Run: npm test
// ==================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpVerifyProvider } from '../src/modules/registration/services/verify/httpVerifyProvider.js';
import { createStubVerifyProvider } from '../src/modules/registration/services/verify/stubVerifyProvider.js';
import { createVerifyProvider } from '../src/modules/registration/services/verify/verifyProvider.factory.js';
import { env } from '../src/config/env.js';

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

test('GSTIN: posts {gstin} to /api/verify/gstin', async () => {
  let seenUrl;
  let seenBody;
  mockFetch(async (url, options) => {
    seenUrl = url;
    seenBody = JSON.parse(options.body);
    return jsonResponse(200, { status: true, message: 'GSTIN verified successfully', data: { gstin: '08AKWPJ1234H1ZN' } });
  });

  const provider = createHttpVerifyProvider();
  const result = await provider.verify({ docType: 'GSTIN', value: '08AKWPJ1234H1ZN' });

  assert.equal(seenUrl, `${env.OCR_API_BASE_URL}/api/verify/gstin`);
  assert.deepEqual(seenBody, { gstin: '08AKWPJ1234H1ZN' });
  assert.equal(result.verified, true);
  assert.equal(result.message, 'GSTIN verified successfully');
});

test('a network failure throws VERIFY_REQUEST_FAILED', async () => {
  mockFetch(async () => {
    throw new Error('ECONNREFUSED');
  });

  const provider = createHttpVerifyProvider();
  await assert.rejects(
    provider.verify({ docType: 'GSTIN', value: 'X' }),
    (err) => err.errorCode === 'VERIFY_REQUEST_FAILED',
  );
});

test('a non-2xx response throws VERIFY_REQUEST_FAILED', async () => {
  mockFetch(async () => jsonResponse(500, { status: false, message: 'upstream down' }));

  const provider = createHttpVerifyProvider();
  await assert.rejects(
    provider.verify({ docType: 'GSTIN', value: 'X' }),
    (err) => err.errorCode === 'VERIFY_REQUEST_FAILED',
  );
});

test('a 2xx response with status:false (an invalid GSTIN) is a verdict, not a failure', async () => {
  // The exact real-world shape a live probe returned for an invalid GSTIN.
  mockFetch(async () => jsonResponse(200, { status: false, message: 'Invalid GSTIN', data: null }));

  const provider = createHttpVerifyProvider();
  const result = await provider.verify({ docType: 'GSTIN', value: 'X' });

  // Throwing here would put a registry that said "no" through the same path as
  // a registry that could not be reached, and the member would be told we are
  // having trouble rather than that the number is not registered.
  assert.equal(result.verified, false);
  assert.equal(result.message, 'Invalid GSTIN');
});

test('a 5xx with status:false still throws - the lookup did not happen', async () => {
  mockFetch(async () => jsonResponse(502, {
    status: false, message: 'Unable to verify GSTIN.', code: 'GSTIN_VERIFICATION_UNAVAILABLE',
  }));

  const provider = createHttpVerifyProvider();
  await assert.rejects(
    provider.verify({ docType: 'GSTIN', value: 'X' }),
    (err) => err.errorCode === 'VERIFY_REQUEST_FAILED'
      && err.details.code === 'GSTIN_VERIFICATION_UNAVAILABLE',
  );
});

test('the stub provider always throws VERIFY_NOT_IMPLEMENTED', async () => {
  const provider = createStubVerifyProvider();
  await assert.rejects(
    provider.verify({ docType: 'GSTIN', value: 'X' }),
    (err) => err.errorCode === 'VERIFY_NOT_IMPLEMENTED',
  );
});

test('the factory returns a usable provider for the current OCR_PROVIDER setting', () => {
  // env is frozen at boot (config/env.js), so this can't flip OCR_PROVIDER mid-test the way a real
  // stub-vs-http switch would - it just confirms the factory wires up cleanly for whichever
  // implementation the running config actually selects (default: 'http').
  assert.equal(typeof createVerifyProvider().verify, 'function');
});

test('createHttpVerifyProvider and createStubVerifyProvider are genuinely different implementations', async () => {
  // The switch in verifyProvider.factory.js is only worth having if the two branches actually
  // behave differently - pin that directly, independent of which one OCR_PROVIDER currently picks.
  // fetch is mocked so this stays offline like every other test here (no real call to ocr.choira.io).
  mockFetch(async () => jsonResponse(200, { status: true, message: 'ok', data: {} }));
  const httpResult = await createHttpVerifyProvider().verify({ docType: 'GSTIN', value: 'X' });
  assert.equal(httpResult.verified, true, 'http actually calls out and resolves');

  await assert.rejects(
    createStubVerifyProvider().verify({ docType: 'GSTIN', value: 'X' }),
    (err) => err.errorCode === 'VERIFY_NOT_IMPLEMENTED',
  );
});
