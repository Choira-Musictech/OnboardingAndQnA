// ==================================================================
// Registration-complete emails (node:test): the IPRS notice + the member's confirmation, and
// complete() sending them only on the first transition into the completed state.
// Fake mailer and stubbed repository singletons - no SMTP, no database.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistrationEmailService,
  registrationEmailService,
} from '../src/modules/registration/services/registrationEmail.service.js';
import { registrationRepository } from '../src/modules/registration/repositories/registration.repository.js';
import { registrationService } from '../src/modules/registration/services/registration.service.js';
import { paymentRepository } from '../src/modules/payment/repositories/payment.repository.js';

const ACCOUNT = {
  AccountId: 18671n,
  AccountName: 'ROHIT PETHKAR',
  AccountCode: 'c-23100',
  RollTypeIds: '2,1',
  BookId: 6n,
  AccountEmail: 'rohit@example.com',
};

function setup({ iprsEmail = 'dev@choira.io', mailer } = {}) {
  const sent = [];
  const service = createRegistrationEmailService({
    mailer: mailer ?? (async (mail) => sent.push(mail)),
    findBookName: async (bookId) => (bookId == null ? null : 'West Individual'),
    iprsEmail,
  });
  return { sent, service };
}

test('both mails go out, to IPRS and to the member, with their subjects', async () => {
  const { sent, service } = setup();
  await service.sendCompletionEmails(ACCOUNT);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'dev@choira.io');
  assert.equal(sent[0].subject, 'Successful Registration by Member');
  assert.equal(sent[1].to, 'rohit@example.com');
  assert.equal(sent[1].subject, 'Successful Submission of Application');
  assert.match(sent[1].html, /Dear ROHIT PETHKAR,/);
  assert.match(sent[1].html, /Thank you for completing the application process/);
});

test('the IPRS notice carries the name, uppercased code, every role and the book name', async () => {
  const { sent, service } = setup();
  await service.sendCompletionEmails(ACCOUNT);
  const { html, text } = sent[0];

  assert.match(html, /Name - ROHIT PETHKAR/);
  assert.match(html, /Code - C-23100/);
  assert.match(html, /Role - Lyricist, Composer/);
  assert.match(html, /Type - West Individual/);
  assert.match(html, /href="https:\/\/lic\.iprs\.org\/"/);
  assert.match(text, /Type - West Individual/);
});

test('missing values show as a dash instead of breaking the mail', async () => {
  const { sent, service } = setup();
  await service.sendCompletionEmails({ ...ACCOUNT, AccountName: null, BookId: null, RollTypeIds: null });

  assert.match(sent[0].html, /Name - -/);
  assert.match(sent[0].html, /Role - -/);
  assert.match(sent[0].html, /Type - -/);
});

test('with no IPRS address configured, only the member mail is sent', async () => {
  const { sent, service } = setup({ iprsEmail: '' });
  await service.sendCompletionEmails(ACCOUNT);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rohit@example.com');
});

test('a failing mail never rejects, and the other mail still goes out', async () => {
  const sent = [];
  const mailer = async (mail) => {
    if (mail.to === 'dev@choira.io') throw new Error('SMTP down');
    sent.push(mail);
  };
  const { service } = setup({ mailer });

  await service.sendCompletionEmails(ACCOUNT);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'rohit@example.com');
});

test('an OCR-read name cannot inject HTML into the IPRS notice', async () => {
  const { sent, service } = setup();
  await service.sendCompletionEmails({ ...ACCOUNT, AccountName: '<script>alert(1)</script>' });

  assert.doesNotMatch(sent[0].html, /<script>/);
  assert.match(sent[0].html, /&lt;script&gt;/);
});

// complete() itself, with every dependency it touches stubbed. A real completion needs the DB;
// these only pin who decides to send.
async function runComplete({ applicationStatus, firstTime }) {
  const original = {
    findByAccountId: registrationRepository.findByAccountId,
    findDocumentsByAccountId: registrationRepository.findDocumentsByAccountId,
    markCompleted: registrationRepository.markCompleted,
    update: registrationRepository.update,
    hasSuccessfulPayment: paymentRepository.hasSuccessfulPayment,
    sendCompletionEmails: registrationEmailService.sendCompletionEmails,
  };
  let mailed = 0;
  let marked = 0;

  registrationRepository.findByAccountId = async () => ({
    ...ACCOUNT,
    ApplicationStatus: marked ? 1 : applicationStatus,
    TeritoryAppFor: 'INDIA',
  });
  registrationRepository.findDocumentsByAccountId = async () =>
    ['PAN', 'BANK', 'PERMANENT_ADDRESS_PROOF'].map((DocumentName) => ({ DocumentName }));
  registrationRepository.markCompleted = async () => {
    marked += 1;
    return firstTime;
  };
  registrationRepository.update = async () => {};
  paymentRepository.hasSuccessfulPayment = async () => true;
  registrationEmailService.sendCompletionEmails = async () => {
    mailed += 1;
  };

  try {
    await registrationService.complete('18671', '18671');
    return { mailed, marked };
  } finally {
    Object.assign(registrationRepository, {
      findByAccountId: original.findByAccountId,
      findDocumentsByAccountId: original.findDocumentsByAccountId,
      markCompleted: original.markCompleted,
      update: original.update,
    });
    paymentRepository.hasSuccessfulPayment = original.hasSuccessfulPayment;
    registrationEmailService.sendCompletionEmails = original.sendCompletionEmails;
  }
}

test('complete() sends the emails when its call is the one that completed the account', async () => {
  assert.deepEqual(await runComplete({ applicationStatus: 0, firstTime: true }), { mailed: 1, marked: 1 });
});

test('complete() sends nothing when a racing call already completed the account', async () => {
  assert.deepEqual(await runComplete({ applicationStatus: 0, firstTime: false }), { mailed: 0, marked: 1 });
});

test('complete() sends nothing for an account that was already complete', async () => {
  assert.deepEqual(await runComplete({ applicationStatus: 1, firstTime: true }), { mailed: 0, marked: 0 });
});

test('the IPRS notice opens with Dear Sir and both mails carry the IPRS signature', async () => {
  const { sent, service } = setup();
  await service.sendCompletionEmails(ACCOUNT);

  assert.match(sent[0].html, /^Dear Sir,/);
  assert.match(sent[0].html, /Successful Registration by New Member/);
  for (const mail of sent) {
    assert.match(mail.html, /Admin-Membership/);
    assert.match(mail.text, /Admin-Membership/);
  }
});

test('the member mail falls back to Dear Applicant and escapes the name', async () => {
  const { sent, service } = setup();
  await service.sendCompletionEmails({ ...ACCOUNT, AccountName: null });
  assert.match(sent[1].html, /^Dear Applicant,/);

  sent.length = 0;
  await service.sendCompletionEmails({ ...ACCOUNT, AccountName: '<b>X</b>' });
  assert.match(sent[1].html, /^Dear &lt;b&gt;X&lt;\/b&gt;,/);
});
