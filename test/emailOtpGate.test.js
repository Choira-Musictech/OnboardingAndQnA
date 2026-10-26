// ==================================================================
// The email-verification step (node:test).
//
// Two layers:
//   1. the gate's own vocabulary and messages - pure, always run
//   2. the engine's change-email escape - needs SQL Server, skipped
//      when it isn't reachable (same convention as smoke.test.js)
//
// The escape exists because a mistyped address used to be an
// unrecoverable dead end: no code ever arrived, every OTP guess failed,
// and `resend` mailed the same wrong address again. The only way out
// was to abandon the whole registration.
//
// This file monkey-patches the mail and Typebot singletons. node:test
// runs each file in its own process, so that stays contained here.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isResendKeyword,
  isChangeEmailKeyword,
  isValidEmail,
  isEmailStep,
  EMAIL_VARIABLE_ID,
  MAX_EMAIL_CHANGES,
  describeOtpSent,
  describeOtpProblem,
  describeChangeLimitReached,
} from '../src/modules/conversation/services/emailOtpGate.js';
import { prisma } from '../src/shared/prisma.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { emailOtpService } from '../src/modules/auth/services/emailOtp.service.js';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';

// --- layer 1: the gate's vocabulary ---------------------------------------

test('the OTP step recognises its own block', () => {
  assert.equal(isEmailStep(EMAIL_VARIABLE_ID), true);
  assert.equal(isEmailStep('some-other-block'), false);
});

test('resend keywords are recognised, ordinary input is not', () => {
  for (const word of ['resend', 'Resend', '  RESEND OTP  ', 'new otp', 'send again']) {
    assert.equal(isResendKeyword(word), true, word);
  }
  for (const word of ['1234', 'resend it please', '', undefined]) {
    assert.equal(isResendKeyword(word), false, String(word));
  }
});

test('change keywords are recognised and do not collide with resend', () => {
  for (const word of ['change', 'Change Email', '  wrong email ', 'different email']) {
    assert.equal(isChangeEmailKeyword(word), true, word);
    assert.equal(isResendKeyword(word), false, word);
  }
  // An OTP must never be read as a keyword.
  assert.equal(isChangeEmailKeyword('1234'), false);
});

test('the EMAIL_OTP_INPUT button labels hit the same matchers as the typed keywords', () => {
  // registrationEngine.js's EMAIL_OTP_INPUT.items carries these exact strings as button content -
  // sendAnswer() posts a tapped button's label back as plain text, so a click and a typed keyword
  // must resolve identically here.
  assert.equal(isResendKeyword('Resend OTP'), true);
  assert.equal(isChangeEmailKeyword('Change email'), true);
  assert.equal(isChangeEmailKeyword('Resend OTP'), false);
  assert.equal(isResendKeyword('Change email'), false);
});

test('email format check', () => {
  assert.equal(isValidEmail('a@b.co'), true);
  for (const bad of ['a@b', 'no-at-sign.com', 'two @spaces.com', '', null]) {
    assert.equal(isValidEmail(bad), false, String(bad));
  }
});

test('both escapes are offered up front, not only after a failure', () => {
  const sent = describeOtpSent('member@example.com');
  assert.match(sent, /member@example\.com/);
  assert.match(sent, /resend/i);
  assert.match(sent, /change/i);

  const problem = describeOtpProblem('Invalid OTP.');
  assert.match(problem, /Invalid OTP\./);
  assert.match(problem, /resend/i);
  assert.match(problem, /change/i);
});

test('the cap message names the limit and points somewhere', () => {
  const message = describeChangeLimitReached();
  assert.match(message, new RegExp(String(MAX_EMAIL_CHANGES)));
  // Either a configured support contact or the neutral fallback - never a dangling empty contact.
  assert.ok(/write to \S+/.test(message) || /get in touch/.test(message), message);
  // A late code must still be usable after the cap.
  assert.match(message, /enter it here/i);
});

test('the cap is a real bound, not disabled', () => {
  assert.ok(Number.isInteger(MAX_EMAIL_CHANGES) && MAX_EMAIL_CHANGES > 0 && MAX_EMAIL_CHANGES <= 5);
});

// --- layer 2: the escape, driven through the engine ------------------------

let dbAvailable = false;
const mailedTo = [];
const CORRECT_OTP = '1234';
const EMAIL_INPUT = { id: 'email-block', type: 'text input', options: { variableId: EMAIL_VARIABLE_ID } };
const createdAccountIds = [];

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }

  // Nothing leaves the machine: no mail, no Typebot call.
  emailOtpService.sendEmailOtp = async ({ email }) => {
    mailedTo.push(email);
    return { message: 'ok' };
  };
  emailOtpService.verifyEmailOtp = async ({ otp }) => {
    if (otp !== CORRECT_OTP) {
      throw Object.assign(new Error('Invalid OTP. 4 attempts left.'), { statusCode: 400 });
    }
    return { message: 'verified' };
  };
  typebotClient.continueChat = async () => ({
    messages: [],
    input: { id: 'next-block', type: 'text input', options: {} },
  });
});

after(async () => {
  for (const id of createdAccountIds) {
    // handle() journals every accepted answer now, so driving it here leaves rows behind.
    await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

// A throwaway account parked on the email question.
async function startAtEmailStep() {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9100${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
    },
  });
  createdAccountIds.push(account.AccountId);
  const userId = String(account.AccountId);
  typebotSessionStore.set(userId, { sessionId: 'fake-session', input: EMAIL_INPUT });
  return { account, userId };
}

const say = (userId, message) => handle({ userId, token: 'test-token', message });

test('a typo is recoverable: change -> new address -> the corrected email is saved', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { account, userId } = await startAtEmailStep();
  mailedTo.length = 0;

  let res = await say(userId, 'wrogn@example.invalid');
  assert.equal(res.input?.id, 'email-otp-verification', 'the OTP step should be reached');
  assert.equal(mailedTo[0], 'wrogn@example.invalid', 'the first code goes to the typo');

  res = await say(userId, 'change');
  assert.equal(res.input?.id, 'email-block', 'the real Typebot email block comes back');

  mailedTo.length = 0;
  res = await say(userId, 'right@example.invalid');
  assert.equal(mailedTo[0], 'right@example.invalid', 'a fresh code goes to the NEW address');
  assert.equal(res.input?.id, 'email-otp-verification');

  res = await say(userId, CORRECT_OTP);
  assert.equal(res.input?.id, 'next-block', 'the conversation advances');

  const saved = await prisma.appAccounts.findUnique({
    where: { AccountId: account.AccountId },
    select: { AccountEmail: true },
  });
  assert.equal(saved.AccountEmail, 'right@example.invalid', 'the corrected address, not the typo');
});

test('the change counter survives the session writes in between', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // typebotSessionStore.set() replaces the whole session object, so `emailChanges` has to be
  // carried forward by hand at every write on this path. Miss one and the cap silently resets.
  // A resend and a failed OTP are both such writes.
  const { userId } = await startAtEmailStep();

  await say(userId, 'one@example.invalid');
  await say(userId, 'change'); // 1
  await say(userId, 'two@example.invalid');
  await say(userId, 'resend');
  await say(userId, '9999'); // a wrong OTP
  await say(userId, 'change'); // 2
  await say(userId, 'three@example.invalid');

  assert.equal(typebotSessionStore.get(userId)?.emailChanges, 2, 'counted 2, not reset to 1');
});

test('the cap holds, and a late code is still usable afterwards', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  await say(userId, 'first@example.invalid');

  for (let i = 1; i <= MAX_EMAIL_CHANGES; i += 1) {
    await say(userId, 'change');
    await say(userId, `attempt${i}@example.invalid`);
  }
  assert.equal(typebotSessionStore.get(userId)?.emailChanges, MAX_EMAIL_CHANGES);

  mailedTo.length = 0;
  const refused = await say(userId, 'change');
  assert.equal(refused.input?.id, 'email-otp-verification', 'still on the OTP field, not advanced');
  assert.equal(mailedTo.length, 0, 'no further mail is sent once the cap is reached');

  const after = await say(userId, CORRECT_OTP);
  assert.equal(after.input?.id, 'next-block', 'the OTP still works after the cap');
});

// The 60-second cooldown is per address: Change email, then the same address again within the minute
// is refused with a wait. That is not a failure - a code is already in their inbox - so the OTP step
// has to stay on that address, or Resend OTP / the code itself find nothing pending.
async function sayWhileOnCooldown(userId, message) {
  const real = emailOtpService.sendEmailOtp;
  emailOtpService.sendEmailOtp = async () => {
    throw Object.assign(new Error('Please wait 51 seconds before requesting another OTP.'), { details: { retryAfterSeconds: 51 } });
  };
  try {
    return await say(userId, message);
  } finally {
    emailOtpService.sendEmailOtp = real;
  }
}

const textOf = (res) => (res.messages ?? []).map((m) => m.content?.richText?.[0]?.children?.[0]?.text ?? '').join(' ');

test('a cooldown after Change email keeps the OTP step, so Resend OTP sends the code once the wait is over', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  await say(userId, 'cooldown@example.invalid');
  await say(userId, 'change');

  const waiting = await sayWhileOnCooldown(userId, 'cooldown@example.invalid');
  assert.equal(waiting.input?.id, 'email-otp-verification', 'the OTP step, with its Resend / Change buttons');
  assert.match(textOf(waiting), /wait 51 seconds/);
  const session = typebotSessionStore.get(userId);
  assert.equal(session.pendingEmailVerification.email, 'cooldown@example.invalid');
  assert.equal(session.emailChanges, 1, 'the change counter is carried');

  mailedTo.length = 0;
  const resent = await say(userId, 'Resend OTP');
  assert.deepEqual(mailedTo, ['cooldown@example.invalid'], 'Resend OTP sends a code to that address');
  assert.equal(resent.input?.id, 'email-otp-verification');
  assert.doesNotMatch(textOf(resent), /enter your email address again/i);
});

test('a cooldown after Change email still lets the code already sent be entered', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  await say(userId, 'cooldown@example.invalid');
  await say(userId, 'change');
  await sayWhileOnCooldown(userId, 'cooldown@example.invalid');

  const verified = await say(userId, CORRECT_OTP);
  assert.equal(verified.input?.id, 'next-block', 'the conversation advances');
});

test('a send that fails for another reason still leaves the plain email question', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  const real = emailOtpService.sendEmailOtp;
  emailOtpService.sendEmailOtp = async () => {
    throw new Error('Failed to send OTP email');
  };
  let res;
  try {
    res = await say(userId, 'mailfail@example.invalid');
  } finally {
    emailOtpService.sendEmailOtp = real;
  }
  assert.equal(res.input?.id, 'email-block', 'asked for the address again');
  assert.equal(typebotSessionStore.get(userId).pendingEmailVerification, undefined);
});

test('a correct address on the first try still verifies in one pass', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  mailedTo.length = 0;

  await say(userId, 'fine@example.invalid');
  const res = await say(userId, CORRECT_OTP);

  assert.equal(res.input?.id, 'next-block');
  assert.equal(mailedTo.length, 1, 'exactly one code was sent');
  assert.equal(typebotSessionStore.get(userId)?.emailChanges ?? 0, 0, 'no change was counted');
});

// --- a refresh in the middle of the OTP step --------------------------------
//
// A refresh sends an empty start call, which throws the stored session away - and with it "a code is
// on its way to this address". Resend OTP then reached the email gate as if it were an address and was
// refused as "not a valid email". The OTP step now comes back with the resumed chat.

const texts = (res) =>
  (res.messages ?? []).map((m) => m.content?.richText?.[0]?.children?.[0]?.text ?? '').join(' || ');

// Journal one answered question and make the replay land on `landsOn`.
async function refreshInto(t, userId, landsOn) {
  const { conversationJournalService } = await import('../src/modules/conversation/services/conversationJournal.service.js');
  await conversationJournalService.recordTurn({ userId, blockId: 'b1', answer: 'answer-b1' });

  const real = { start: typebotClient.startChat, cont: typebotClient.continueChat };
  typebotClient.startChat = async () => ({ sessionId: 'resume-session', messages: [], input: { id: 'b1' } });
  // The replay lands on `landsOn`; anything the member answers afterwards moves on as usual.
  let replayed = false;
  typebotClient.continueChat = async () => {
    const input = replayed ? { id: 'next-block', type: 'text input', options: {} } : landsOn;
    replayed = true;
    return { messages: [], input };
  };
  t.after(() => {
    typebotClient.startChat = real.start;
    typebotClient.continueChat = real.cont;
  });

  const offer = await say(userId, undefined);
  assert.equal(offer.input?.id, 'resume-registration', 'a refresh offers to resume');
  return say(userId, 'Continue where I left off');
}

test('after a refresh the OTP step comes back, and Resend OTP sends a new code to the same address', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  await say(userId, 'member@example.invalid');

  const resumed = await refreshInto(t, userId, EMAIL_INPUT);
  assert.equal(resumed.input?.id, 'email-otp-verification', 'the OTP step, not the bare email question');
  assert.match(texts(resumed), /member@example\.invalid/);

  mailedTo.length = 0;
  const resent = await say(userId, 'Resend OTP');
  assert.deepEqual(mailedTo, ['member@example.invalid'], 'a new code goes to the address already entered');
  assert.equal(resent.input?.id, 'email-otp-verification');
  assert.doesNotMatch(texts(resent), /valid email/i);

  const done = await say(userId, CORRECT_OTP);
  assert.equal(done.input?.id, 'next-block', 'the code still verifies after the refresh');
});

test('a refresh keeps the count of changed addresses', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  await say(userId, 'one@example.invalid');
  await say(userId, 'change'); // 1
  await say(userId, 'two@example.invalid');

  await refreshInto(t, userId, EMAIL_INPUT);
  assert.equal(typebotSessionStore.get(userId)?.emailChanges, 1);
});

test('a refresh that lands on another question does not bring the OTP step back', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const { userId } = await startAtEmailStep();
  await say(userId, 'member@example.invalid');

  const resumed = await refreshInto(t, userId, { id: 'other-block', type: 'text input', options: {} });
  assert.equal(resumed.input?.id, 'other-block');
  assert.equal(typebotSessionStore.get(userId)?.pendingEmailVerification, undefined);
});

test('Resend OTP with no code on its way asks for the address instead of calling it invalid', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // e.g. the server restarted: the session is back on the plain email question and remembers nothing.
  const { userId } = await startAtEmailStep();
  mailedTo.length = 0;

  for (const button of ['Resend OTP', 'Change email']) {
    const res = await say(userId, button);
    assert.equal(res.input?.id, 'email-block', 'still on the email question');
    assert.match(texts(res), /enter your email address again/i);
    assert.doesNotMatch(texts(res), /valid email/i);
  }
  assert.equal(mailedTo.length, 0, 'nothing is mailed for a button tap');
});
