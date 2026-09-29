// ==================================================================
// The GST-number verify gate (node:test). TAN is not wired in - no
// Studio question exists for it, see verifyGate.js.
//
// Two layers, same convention as emailOtpGate.test.js:
//   1. the gate's own recognition/message vocabulary - pure, always run
//   2. the engine's block-until-verified behaviour - needs SQL Server,
//      skipped when it isn't reachable
//
// Layer 2 monkey-patches verifyProvider.verify and typebotClient, same
// technique emailOtpGate.test.js uses for emailOtpService/typebotClient.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchVerifyStep,
  describeVerifyFailure,
  describeVerifyError,
  verifyProvider,
  GSTIN_VARIABLE_ID,
} from '../src/modules/conversation/services/typebot/verifyGate.js';
import { prisma } from '../src/shared/prisma.js';
import { env } from '../src/config/env.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';

// --- layer 1: the gate's vocabulary ---------------------------------------

test('the GST step recognises its own block, nothing else', () => {
  const config = matchVerifyStep(GSTIN_VARIABLE_ID);
  assert.equal(config?.docType, 'GSTIN');
  assert.equal(matchVerifyStep('some-other-block'), null);
});

test('a failure message prefers the service\'s own reason, falls back when blank', () => {
  assert.equal(
    describeVerifyFailure('GST number', 'GSTIN not found'),
    'GSTIN not found. Please check it and enter it again.',
  );
  assert.equal(
    describeVerifyFailure('TAN', ''),
    "We couldn't verify that TAN. Please check it and enter it again.",
  );
  assert.equal(
    describeVerifyFailure('TAN', undefined),
    "We couldn't verify that TAN. Please check it and enter it again.",
  );
});

test('a call-failed message with no service reason stays generic and never leaks the raw error', () => {
  const message = describeVerifyError('GST number');
  assert.match(message, /trouble verifying/i);
  assert.match(message, /GST number/);
  assert.doesNotMatch(message, /ECONNREFUSED|Error:|undefined/);
});

test('a call-failed message WITH a service reason (e.g. malformed GSTIN) shows it instead of the generic wording', () => {
  const message = describeVerifyError('GST number', 'That is not a valid GSTIN format.');
  assert.equal(message, 'That is not a valid GSTIN format. Please check it and enter it again.');
  assert.doesNotMatch(message, /trouble verifying/i);
});

// --- layer 2: blocking-until-verified, driven through the engine -----------

let dbAvailable = false;
const GST_INPUT = { id: 'gst-block', type: 'text input', options: { variableId: GSTIN_VARIABLE_ID } };
const createdAccountIds = [];
const originalVerify = verifyProvider.verify;

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }

  typebotClient.continueChat = async () => ({
    messages: [],
    input: { id: 'next-block', type: 'text input', options: {} },
  });
});

after(async () => {
  verifyProvider.verify = originalVerify;
  for (const id of createdAccountIds) {
    await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function startAtGstStep() {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9200${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
    },
  });
  createdAccountIds.push(account.AccountId);
  const userId = String(account.AccountId);
  typebotSessionStore.set(userId, { sessionId: 'fake-session', input: GST_INPUT });
  return { account, userId };
}

const say = (userId, message) => handle({ userId, token: 'test-token', message });

// env.GST_VERIFY_ENABLED is read from the ambient .env (frozen at process start, can't be monkey-
// patched here) - a developer testing locally with it set to false gets these skipped rather than
// a false failure. See the dedicated "gate bypassed" test below for that state instead.
test('verified: true relays through and persists Detail1', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.GST_VERIFY_ENABLED) return t.skip('GST_VERIFY_ENABLED is false - gate is bypassed locally');
  verifyProvider.verify = async () => ({ verified: true, message: 'ok' });
  const { account, userId } = await startAtGstStep();

  const res = await say(userId, '08AKWPJ1234H1ZN');
  assert.equal(res.input?.id, 'next-block', 'the conversation advances');

  const saved = await prisma.appAccounts.findUnique({ where: { AccountId: account.AccountId }, select: { Detail1: true } });
  assert.equal(saved.Detail1, '08AKWPJ1234H1ZN');
});

test('verified: false stays on the same step and never persists the bad value', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.GST_VERIFY_ENABLED) return t.skip('GST_VERIFY_ENABLED is false - gate is bypassed locally');
  verifyProvider.verify = async () => ({ verified: false, message: 'GSTIN not found' });
  const { account, userId } = await startAtGstStep();

  const res = await say(userId, 'NOTAREALGSTIN');
  assert.equal(res.input?.id, 'gst-block', 'still parked on the GST question');
  assert.match(res.messages[0].content.richText[0].children[0].text ?? JSON.stringify(res.messages[0]), /GSTIN not found/);

  const saved = await prisma.appAccounts.findUnique({ where: { AccountId: account.AccountId }, select: { Detail1: true } });
  assert.equal(saved.Detail1, null, 'nothing was written for a failed verification');
});

test('a provider error also stays on the same step, with a distinct message', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.GST_VERIFY_ENABLED) return t.skip('GST_VERIFY_ENABLED is false - gate is bypassed locally');
  verifyProvider.verify = async () => {
    throw new Error('ECONNREFUSED');
  };
  const { userId } = await startAtGstStep();

  const res = await say(userId, '08AKWPJ1234H1ZN');
  assert.equal(res.input?.id, 'gst-block');
});

test('a provider error carrying the service\'s own reason (details.message) surfaces it to the member', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.GST_VERIFY_ENABLED) return t.skip('GST_VERIFY_ENABLED is false - gate is bypassed locally');
  verifyProvider.verify = async () => {
    const err = new Error('That is not a valid GSTIN format.');
    err.details = { stage: 'verify_call', docType: 'GSTIN', message: 'That is not a valid GSTIN format.', code: 'GSTIN_MALFORMED' };
    throw err;
  };
  const { userId } = await startAtGstStep();

  const res = await say(userId, 'not-a-real-gstin');
  assert.equal(res.input?.id, 'gst-block');
  const text = res.messages[0].content.richText[0].children[0].text ?? JSON.stringify(res.messages[0]);
  assert.match(text, /not a valid GSTIN format/);
  assert.doesNotMatch(text, /trouble verifying/i);
});

test('retries are unbounded: several failures then a success still works', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (!env.GST_VERIFY_ENABLED) return t.skip('GST_VERIFY_ENABLED is false - gate is bypassed locally');
  const { account, userId } = await startAtGstStep();

  verifyProvider.verify = async () => ({ verified: false, message: 'no' });
  for (let i = 0; i < 4; i += 1) {
    const res = await say(userId, `attempt-${i}`);
    assert.equal(res.input?.id, 'gst-block');
  }

  verifyProvider.verify = async () => ({ verified: true, message: 'ok' });
  const res = await say(userId, '08AKWPJ1234H1ZN');
  assert.equal(res.input?.id, 'next-block', 'no cap - the next attempt still succeeds');

  const saved = await prisma.appAccounts.findUnique({ where: { AccountId: account.AccountId }, select: { Detail1: true } });
  assert.equal(saved.Detail1, '08AKWPJ1234H1ZN');
});

// --- GST_VERIFY_ENABLED=false: the gate is bypassed entirely, mirroring OCR_ENABLED -----------------

test('with GST_VERIFY_ENABLED off, a malformed value advances anyway and is persisted unchecked', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  if (env.GST_VERIFY_ENABLED) return t.skip('GST_VERIFY_ENABLED is true here - see the gated tests above instead');

  // Never called when the gate is bypassed - throwing proves it, same technique as the other
  // "provider error" tests but inverted: this must NOT surface as a block.
  verifyProvider.verify = async () => {
    throw new Error('verifyProvider.verify should not be called when GST_VERIFY_ENABLED is false');
  };
  const { account, userId } = await startAtGstStep();

  const res = await say(userId, 'not-a-real-gstin');
  assert.equal(res.input?.id, 'next-block', 'the conversation advances even though the value is nonsense');

  const saved = await prisma.appAccounts.findUnique({ where: { AccountId: account.AccountId }, select: { Detail1: true } });
  assert.equal(saved.Detail1, 'not-a-real-gstin', 'the typed answer is still saved, same as any other unguarded text field');
});
