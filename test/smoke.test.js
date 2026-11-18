// ==================================================================
// Smoke tests - health, auth round-trip, Typebot registration flow (node:test).
// DB-dependent tests are skipped automatically when SQL Server is unreachable.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { prisma } from '../src/shared/prisma.js';

let server;
let baseUrl;
let dbAvailable = false;

before(async () => {
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await prisma.$disconnect().catch(() => {});
  server.close();
});

test('GET /health returns structured report (db up when reachable)', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.uptime >= 0);
  assert.ok(body.data.timestamp);
  assert.ok(['up', 'down'].includes(body.data.db));
});

test('unknown route returns 404 JSON', async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('invalid body is rejected with 422', async () => {
  const res = await fetch(`${baseUrl}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: 'abc' }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('auth round-trip: send-otp -> verify-otp -> protected endpoint', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if ((process.env.OTP_PROVIDER ?? 'mock') !== 'mock') {
    return t.skip('OTP round-trip only works with the mock provider (real OTP is sent via SMS)');
  }
  const phone = `+1555${Date.now().toString().slice(-7)}`;

  const sent = await fetch(`${baseUrl}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  assert.equal(sent.status, 200);
  const sentBody = await sent.json();
  assert.ok(sentBody.data.otp, 'mock provider should echo the OTP');

  const verified = await fetch(`${baseUrl}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone,
      otp: sentBody.data.otp,
    }),
  });
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.ok(verifiedBody.data.token);
  assert.equal(verifiedBody.data.user.phone, phone);

  const reg = await fetch(`${baseUrl}/registration/status`, {
    headers: { authorization: `Bearer ${verifiedBody.data.token}` },
  });
  assert.equal(reg.status, 200);
  const regBody = await reg.json();
  assert.equal(regBody.data.completed, false);

  // The onboarding flow runs inside the backend (flowEngine.js) - no external bot to configure, so a
  // fresh member always gets the registration engine's first question.
  const conversation = await fetch(`${baseUrl}/conversation/message`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${verifiedBody.data.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(conversation.status, 200);
  const convBody = await conversation.json();
  assert.equal(convBody.data.engine, 'REGISTRATION');

  const logout = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${verifiedBody.data.token}` },
  });
  assert.equal(logout.status, 200);

  // The token must actually stop working after logout - not just return 200 on the logout call.
  const afterLogout = await fetch(`${baseUrl}/registration/status`, {
    headers: { authorization: `Bearer ${verifiedBody.data.token}` },
  });
  assert.equal(afterLogout.status, 401);
  const afterLogoutBody = await afterLogout.json();
  assert.equal(afterLogoutBody.error.code, 'UNAUTHORIZED');
});

test('Registration flow: documents -> complete', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if ((process.env.OTP_PROVIDER ?? 'mock') !== 'mock') {
    return t.skip('Registration flow only works with the mock OTP provider');
  }

  const phone = `+1555${Date.now().toString().slice(-7)}`;

  const sent = await fetch(`${baseUrl}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  const sentBody = await sent.json();

  const verified = await fetch(`${baseUrl}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, otp: sentBody.data.otp }),
  });
  const verifiedBody = await verified.json();
  const token = verifiedBody.data.token;
  const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // registrationId is just the stringified AccountId - already known from login, no /start needed.
  const registrationId = verifiedBody.data.user.id;

  // unauthorized (no token)
  const noAuth = await fetch(`${baseUrl}/registration/${registrationId}/documents/PAN`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentUrl: 'https://s3.example.com/pan.jpg' }),
  });
  assert.equal(noAuth.status, 401);

  // mismatched registrationId is rejected (ownership check), regardless of DB state
  const foreignId = String(BigInt(registrationId) + 1n);
  const forbidden = await fetch(`${baseUrl}/registration/${foreignId}/documents/PAN`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ documentUrl: 'https://s3.example.com/pan.jpg' }),
  });
  assert.equal(forbidden.status, 403);

  // complete before sections are done -> incomplete
  const incomplete = await fetch(`${baseUrl}/registration/${registrationId}/complete`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(incomplete.status, 400);
  const incompleteBody = await incomplete.json();
  assert.equal(incompleteBody.error.code, 'REGISTRATION_INCOMPLETE');

  // complete() only requires AccountEmail (the one field the live chat flow actually collects) -
  // set it directly via Prisma, since the basic-details REST endpoint was removed as unused
  // (the Typebot flow never calls it - see AGENTS.md).
  await prisma.appAccounts.update({
    where: { AccountId: BigInt(registrationId) },
    data: { AccountEmail: `uday${Date.now()}@example.com` },
  });

  // documents - PAN/BANK/PERMANENT_ADDRESS_PROOF are what complete() now requires (the live chat
  // flow's actual mandatory set), plus AADHAAR (no longer required, but still a valid OCR'd type -
  // exercises that code path) and PROFILE_PHOTO (never OCR'd).
  // The fake s3.example.com URLs can't be OCR'd for real, so PAN/AADHAAR/BANK are expected to come
  // back unverified rather than fail the upload - that graceful-degradation path is the point here.
  const OCR_TYPES = new Set(['PAN', 'AADHAAR', 'BANK']);
  for (const type of ['PAN', 'AADHAAR', 'BANK', 'PROFILE_PHOTO', 'PERMANENT_ADDRESS_PROOF']) {
    const res = await fetch(`${baseUrl}/registration/${registrationId}/documents/${type}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ documentUrl: `https://s3.example.com/${type.toLowerCase()}.jpg` }),
    });
    assert.equal(res.status, 200, `${type} upload should succeed`);
    const body = await res.json();
    assert.equal(body.data.documentType, type);
    if (OCR_TYPES.has(type)) {
      assert.equal(body.data.verified, false, `${type} should be unverified for an unreachable image`);
    } else {
      assert.equal(body.data.verified, undefined, `${type} should never attempt OCR`);
    }
  }

  // invalid document type is rejected
  const invalidDocType = await fetch(`${baseUrl}/registration/${registrationId}/documents/PASSPORT`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ documentUrl: 'https://s3.example.com/passport.jpg' }),
  });
  assert.equal(invalidDocType.status, 422);

  // complete after all sections are done
  const complete = await fetch(`${baseUrl}/registration/${registrationId}/complete`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(complete.status, 200);
  const completeBody = await complete.json();
  assert.equal(completeBody.data.completed, true);

  const status = await fetch(`${baseUrl}/registration/status`, { headers: authHeaders });
  const statusBody = await status.json();
  assert.equal(statusBody.data.completed, true);
});