// ==================================================================
// The pre-payment review (node:test).
//
// Rendering is pure and always runs; building the review reads the
// database and is skipped when SQL Server isn't reachable.
//
// WHY THE SCREEN EXISTS: a good part of what is stored was never typed
// by the member. PAN number, date of birth, bank name, account number,
// IFSC and branch all come from OCR reading their documents - and OCR
// gets things wrong (one live account's BankBranchName holds a passbook
// form label). A wrong account number sends royalties to the wrong
// place, so the last moment to catch it is before payment.
//
// It reads the DATABASE, not Typebot's variables: a value that failed
// to persist must show as missing, which is exactly what the member
// needs to know at this point.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { registrationReviewService, renderSections } from '../src/modules/registration/services/registrationReview.service.js';
import { describeReview } from '../src/modules/conversation/services/typebot/paymentGate.js';

// --- rendering (pure) ------------------------------------------------------

test('renderSections is the shared body describeReview wraps - and anything else can reuse', () => {
  // Pinned directly, not just through describeReview(), because registrationEngine.js's resume
  // summary also calls this - a regression here would silently break both intros at once.
  const sections = [
    { title: 'Your details', lines: [{ label: 'Name', value: 'Arijit Singh' }] },
    { title: 'Documents you uploaded (1)', lines: [{ label: null, value: 'PAN card' }] },
  ];
  const body = renderSections(sections);

  assert.match(body, /Your details\n {2}Name: Arijit Singh/);
  assert.match(body, /Documents you uploaded \(1\)\n {2}- PAN card/);
  assert.equal(describeReview(sections), `Please check your details before payment.\n\n${body}`);
});

test('labelled lines render as "Label: value", unlabelled ones as bullets', () => {
  const text = describeReview([
    { title: 'Your details', lines: [{ label: 'Name', value: 'Arijit Singh' }] },
    { title: 'Documents you uploaded (2)', lines: [{ label: null, value: 'PAN card' }, { label: null, value: 'Bank passbook / cheque' }] },
  ]);

  assert.match(text, /Name: Arijit Singh/);
  // "PAN card: uploaded" reads worse than "- PAN card".
  assert.match(text, /- PAN card/);
  assert.match(text, /- Bank passbook \/ cheque/);
  assert.match(text, /before payment/i);
});

// --- building the review ---------------------------------------------------

let dbAvailable = false;
const createdAccountIds = [];

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  for (const id of createdAccountIds) {
    await prisma.appAccountsWorkRegistration.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function makeAccount(data) {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9300${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
      ...data,
    },
  });
  createdAccountIds.push(account.AccountId);
  return account;
}

const flatten = (sections) => sections.flatMap((s) => s.lines.map((l) => `${l.label ?? ''}|${l.value}`)).join('\n');

test('filled fields appear, under the section a member would look in', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({
    AccountName: 'Arijit Singh',
    AccountAlias: 'Arijit',
    AccountEmail: 'member@example.invalid',
    RollTypeIds: '1', // Composer
    AccountRegType: 'I',
    BankName: 'State Bank of India',
    BankAcNo: '1234567890',
    BankIFSCCode: 'SBIN0001234',
    Detail2: 'ABCDE1234F', // PAN
  });

  const sections = await registrationReviewService.buildReview(String(account.AccountId));
  const titles = sections.map((s) => s.title);
  assert.ok(titles.includes('Your details'), titles.join(','));
  assert.ok(titles.includes('Bank'), titles.join(','));
  assert.ok(titles.includes('Identity'), titles.join(','));

  const body = flatten(sections);
  assert.match(body, /Name\|Arijit Singh/);
  assert.match(body, /Applying as\|\(Individual\) Author \/ Composer/);
  assert.match(body, /Role\|Composer/);
  // Shown in full on purpose - masking the account number would hide the most expensive OCR error.
  assert.match(body, /Account number\|1234567890/);
  assert.match(body, /PAN\|ABCDE1234F/);
});

test('every alias shows under "Stage name" - there is no separate "Also credited as" section', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // Position 0 is the flow's own stage-name answer, the rest are names claimed later via work-link
  // matching (see registration.service.js's addAliases) - all of them belong under one field now.
  const account = await makeAccount({ AccountName: 'Arijit Singh', AccountAlias: 'Arijit, A.R., Pritam' });

  const sections = await registrationReviewService.buildReview(String(account.AccountId));
  const body = flatten(sections);

  assert.match(body, /Stage name\|Arijit, A\.R\., Pritam/);
  assert.equal(sections.some((s) => s.title === 'Also credited as'), false, 'the section must be gone entirely');
});

test('empty fields and empty sections are dropped, not shown blank', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // Nothing but a name: a member who skipped the GST question must never see a blank GST line.
  const account = await makeAccount({ AccountName: 'Only A Name' });

  const sections = await registrationReviewService.buildReview(String(account.AccountId));
  const body = flatten(sections);

  assert.match(body, /Name\|Only A Name/);
  assert.equal(/GST number/.test(body), false);
  assert.equal(/Account number/.test(body), false);
  assert.equal(sections.some((s) => s.lines.length === 0), false, 'no empty section survives');
  assert.equal(/\|\s*$/m.test(body), false, 'no line has a blank value');
});

test('Detail columns show under their real names, and internal ones never reach the member', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // Detail1 = GST and Detail2 = PAN are real member-facing values (this app stores them there
  // rather than adding columns of its own), so they belong in the review - but under those
  // labels, never as "Detail1"/"Detail2". Detail10 is an internal source tag and must not leak.
  const account = await makeAccount({
    AccountName: 'Detail Test',
    Detail1: 'DETAIL1-SENTINEL',
    Detail2: 'DETAIL2-SENTINEL',
    Detail10: 'DETAIL10-SENTINEL',
  });

  const sections = await registrationReviewService.buildReview(String(account.AccountId));
  const body = flatten(sections);

  assert.match(body, /GST number\|DETAIL1-SENTINEL/, 'GST must show under its own label');
  assert.match(body, /PAN\|DETAIL2-SENTINEL/, 'PAN must show under its own label');
  assert.equal(/DETAIL10-SENTINEL/.test(body), false, 'the internal source tag leaked');
  assert.equal(/Detail\d/.test(JSON.stringify(sections)), false, 'a raw column name reached the member');
});

test('songs are listed with a count', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const account = await makeAccount({ AccountName: 'With Songs' });
  await prisma.appAccountsWorkRegistration.create({
    data: {
      AccountId: account.AccountId,
      SongName: 'Kesariya',
      Artist_Singers: 'Pritam, Arijit Singh',
      DigitalLink: 'https://open.spotify.com/track/x',
    },
  });

  const sections = await registrationReviewService.buildReview(String(account.AccountId));
  const songs = sections.find((s) => s.title.startsWith('Your songs'));
  assert.ok(songs, sections.map((s) => s.title).join(','));
  assert.match(songs.title, /\(1\)/);
  assert.equal(songs.lines[0].label, null, 'songs render as bullets');
  assert.match(songs.lines[0].value, /Kesariya/);
});

test('an unknown account is a 404, not an empty review', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  await assert.rejects(
    () => registrationReviewService.buildReview('99999999'),
    (err) => err.statusCode === 404 || /not found/i.test(err.message),
  );
});
