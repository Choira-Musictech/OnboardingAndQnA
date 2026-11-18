// ==================================================================
// The registration engine end to end on the built-in flow engine - nothing stubbed between
// registrationEngine.handle() and the flow file. Needs SQL Server (the journal); skips without it.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { conversationJournalService } from '../src/modules/conversation/services/conversationJournal.service.js';

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
    typebotSessionStore.clear(String(id));
    await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function makeAccount() {
  const account = await prisma.appAccounts.create({
    data: { AccountGroupId: 0, AccountMobile: `9310${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}` },
  });
  createdAccountIds.push(account.AccountId);
  return String(account.AccountId);
}

const texts = (res) => JSON.stringify(res.messages ?? []);

test('a new member walks the first questions through the engine, journalled as before', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const first = await handle({ userId, token: 't' });
  assert.equal(first.input.id, 'tebp7htyvolml8wokttg66pw');
  assert.match(texts(first), /Hello! I am your IPRS assistant\./);
  assert.equal(first.isPaymentStep, false);

  const path = await handle({ userId, token: 't', message: 'Yes, I want to become a member' });
  assert.equal(path.input.id, 'ofaqjfre4b6smht07inyag0w');

  const role = await handle({ userId, token: 't', message: '(Individual) Author / Composer' });
  assert.equal(role.input.id, 'qvo8thfagkj2mixdoj382da4');
  assert.equal(typeof role.progress, 'number');

  // A wrong answer is not journalled and keeps the member on the same question.
  const wrong = await handle({ userId, token: 't', message: 'not a role' });
  assert.equal(wrong.input.id, 'qvo8thfagkj2mixdoj382da4');

  const turns = await conversationJournalService.loadJournal(userId);
  assert.deepEqual(turns.map((turn) => turn.blockId), ['tebp7htyvolml8wokttg66pw', 'ofaqjfre4b6smht07inyag0w']);
});

test('after a restart (chat session gone) the member resumes where they were from the journal', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  await handle({ userId, token: 't' });
  await handle({ userId, token: 't', message: 'Yes, I want to become a member' });
  await handle({ userId, token: 't', message: '(Individual) Author / Composer' });

  // What a server restart leaves behind: no chat session in memory, the journal in the database.
  typebotSessionStore.clear(userId);
  const offer = await handle({ userId, token: 't' });
  assert.equal(offer.input.id, 'resume-registration');
  const resumed = await handle({ userId, token: 't', message: 'Continue where I left off' });
  assert.equal(resumed.input.id, 'qvo8thfagkj2mixdoj382da4', 'back on the role question');
});
