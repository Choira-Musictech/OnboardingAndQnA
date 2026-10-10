// ==================================================================
// Resuming an abandoned registration (node:test).
//
// The replay logic is pure - typebotClient is stubbed, nothing here
// touches the network. Persistence needs SQL Server and is skipped when
// it isn't reachable.
//
// WHAT THIS FILE DEFENDS: a member who left halfway must come back to
// the SAME question, and must never be replayed into a question they
// never actually answered. Two ways that could happen, both pinned
// below:
//   - a rejected answer gets journalled (Typebot answers a bad input
//     with 200 and the same input repeated, so it looks like progress)
//   - a republished flow no longer asks what the journal recorded, and
//     stored answers get fed to the wrong questions
// Both were verified live before this was built: `startFrom` is silently
// ignored on the public endpoint, and a replayed journal lands on the
// identical block id - file uploads included.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { conversationJournalService, REPLAY_STOP, MAX_REPLAY_TURNS } from '../src/modules/conversation/services/conversationJournal.service.js';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { conversationJournalRepository } from '../src/modules/conversation/repositories/conversationJournal.repository.js';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { registrationReviewService } from '../src/modules/registration/services/registrationReview.service.js';
import { workLinkService } from '../src/modules/work/services/workLink.service.js';

// --- replay (pure, typebotClient stubbed) ----------------------------------

const realContinue = typebotClient.continueChat;

// A fake flow: an ordered list of block ids. Answering block N hands back block N+1, which is
// exactly what Typebot does when it accepts an answer.
function stubFlow(blockIds, { failAt = null } = {}) {
  const sent = [];
  let position = 0;
  typebotClient.continueChat = async ({ message }) => {
    if (failAt !== null && sent.length === failAt) throw new Error('typebot exploded');
    sent.push(message);
    position += 1;
    const next = blockIds[position];
    return next ? { input: { id: next }, messages: [] } : { input: null, messages: [] };
  };
  return { sent, start: () => ({ input: { id: blockIds[0] }, messages: [] }) };
}

const turn = (blockId, answer, attachedFileUrls = null) => ({ turnIndex: 0, blockId, answer, attachedFileUrls });

test('a full journal puts the member back on the question they left', async (t) => {
  const flow = stubFlow(['b1', 'b2', 'b3', 'b4']);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', 'Yes'), turn('b2', '(Individual) Author / Composer'), turn('b3', 'I Accept')],
  });

  assert.equal(out.stop, REPLAY_STOP.COMPLETE);
  assert.equal(out.replayed, 3);
  assert.equal(out.response.input.id, 'b4', 'lands on the next unanswered question');
  assert.deepEqual(flow.sent.map((m) => m.text), ['Yes', '(Individual) Author / Composer', 'I Accept']);
});

test('a republished flow stops the replay instead of answering the wrong question', async (t) => {
  // The flow now asks b1 then bX; the journal still says b2. Feeding "I Accept" to bX would put the
  // member on a branch they never chose, with data that looks deliberate.
  const flow = stubFlow(['b1', 'bX', 'bY']);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', 'Yes'), turn('b2', 'I Accept'), turn('b3', 'more')],
  });

  assert.equal(out.stop, REPLAY_STOP.DIVERGED);
  assert.equal(out.replayed, 1, 'only the turn that still matched was replayed');
  assert.equal(out.response.input.id, 'bX', 'the member carries on from the divergence point');
  assert.equal(flow.sent.length, 1, 'the stale answer was never sent');
});

test('a journal whose very first turn no longer matches sends nothing at all', async (t) => {
  const flow = stubFlow(['somewhere-else']);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', 'Yes')],
  });

  assert.equal(out.stop, REPLAY_STOP.DIVERGED);
  assert.equal(out.replayed, 0);
  assert.equal(flow.sent.length, 0);
});

test('file answers are replayed with their attachments, not just the text', async (t) => {
  // Verified live: a presigned URL minted for the old session is still accepted by a new one, and
  // Typebot's own widget sends the URL in BOTH fields - a text-only replay is rejected.
  const flow = stubFlow(['b1', 'b2']);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const url = 'https://s3.example.com/results/r1/blocks/b1/pan.jpeg';
  await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', url, [url])],
  });

  assert.equal(flow.sent[0].text, url);
  assert.deepEqual(flow.sent[0].attachedFileUrls, [url]);
});

test('a mid-replay Typebot failure keeps the progress made so far', async (t) => {
  const flow = stubFlow(['b1', 'b2', 'b3'], { failAt: 1 });
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', 'a'), turn('b2', 'b')],
  });

  assert.equal(out.stop, REPLAY_STOP.FAILED);
  assert.equal(out.replayed, 1, 'half a replay still beats dropping them at question 1');
  assert.equal(out.response.input.id, 'b2');
});

test('a flow that ends during replay reports it rather than looping', async (t) => {
  const flow = stubFlow(['b1', 'b2']);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', 'a'), turn('b2', 'b'), turn('b3', 'c')],
  });

  assert.equal(out.stop, REPLAY_STOP.ENDED);
  assert.equal(out.response.input, null);
});

test('replay is capped - a corrupt journal cannot hammer Typebot forever', async (t) => {
  const many = Array.from({ length: MAX_REPLAY_TURNS + 10 }, (_, i) => `b${i}`);
  const flow = stubFlow(many);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: many.map((id) => turn(id, 'x')),
  });

  assert.equal(out.stop, REPLAY_STOP.CAPPED);
  assert.equal(out.replayed, MAX_REPLAY_TURNS);
});

test('replay reports the input each replayed turn answered, so a question\'s own options can be read back', async (t) => {
  const flow = stubFlow(['b1', 'b2', 'b3']);
  t.after(() => { typebotClient.continueChat = realContinue; });

  const out = await conversationJournalService.replayJournal({
    sessionId: 's1',
    startResponse: flow.start(),
    turns: [turn('b1', 'a'), turn('b2', 'b')],
  });

  assert.deepEqual(out.askedInputs.map((input) => input.id), ['b1', 'b2']);
});

// --- persistence -----------------------------------------------------------

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
    await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccountsWorkRegistration.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function makeAccount() {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9300${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
    },
  });
  createdAccountIds.push(account.AccountId);
  return String(account.AccountId);
}

test('turns are stored in order and read back ready to replay', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  await conversationJournalService.recordTurn({ userId, blockId: 'b1', variableId: 'v1', answer: 'Yes' });
  // A navigation-only choice: no variableId at all. 38 of the flow's 131 inputs look like this, and
  // they are the reason the existing columns cannot reconstruct the path.
  await conversationJournalService.recordTurn({ userId, blockId: 'b2', variableId: null, answer: 'I Accept' });
  await conversationJournalService.recordTurn({
    userId,
    blockId: 'b3',
    answer: 'https://s3/x.jpeg',
    attachedFileUrls: ['https://s3/x.jpeg'],
  });

  const journal = await conversationJournalService.loadJournal(userId);
  assert.deepEqual(journal.map((entry) => entry.blockId), ['b1', 'b2', 'b3']);
  assert.deepEqual(journal.map((entry) => entry.turnIndex), [0, 1, 2], 'no holes, no duplicates');
  assert.deepEqual(journal[2].attachedFileUrls, ['https://s3/x.jpeg'], 'attachments survive the round trip');
  assert.equal(journal[1].attachedFileUrls, null);
  assert.equal(await conversationJournalService.lastBlockId(userId), 'b3');
});

test('a short replay truncates the rest, so the next resume is not poisoned', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  for (const blockId of ['b1', 'b2', 'b3', 'b4']) {
    await conversationJournalService.recordTurn({ userId, blockId, answer: 'x' });
  }

  // Replay only got two turns in before the flow diverged.
  await conversationJournalService.truncateAfterReplay(userId, 2);

  const journal = await conversationJournalService.loadJournal(userId);
  assert.deepEqual(journal.map((entry) => entry.blockId), ['b1', 'b2']);

  // And the next answer appends cleanly rather than leaving a gap where the stale turns were.
  await conversationJournalService.recordTurn({ userId, blockId: 'bNew', answer: 'y' });
  const after = await conversationJournalService.loadJournal(userId);
  assert.deepEqual(after.map((entry) => entry.turnIndex), [0, 1, 2]);
  assert.equal(after[2].blockId, 'bNew');
});

test('starting over leaves nothing behind to resume into', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  await conversationJournalService.recordTurn({ userId, blockId: 'b1', answer: 'Yes' });
  assert.equal(await conversationJournalService.countTurns(userId), 1);

  await conversationJournalService.clearJournal(userId);
  assert.equal(await conversationJournalService.countTurns(userId), 0);
  assert.equal(await conversationJournalService.lastBlockId(userId), null);
});

test('switching an address-proof document rewrites only the newest address-type answer', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();
  const PERMANENT_TYPE = 'vwtm9i19qrzl3dxjzifdw6xnp';
  const CURRENT_TYPE = 'vgbmeklrpc3b4hu8tvmodnt4e';

  await conversationJournalService.recordTurn({ userId, blockId: 'b1', variableId: PERMANENT_TYPE, answer: 'Passport' });
  await conversationJournalService.recordTurn({ userId, blockId: 'b2', answer: 'https://s3/p.jpeg' });
  await conversationJournalService.recordTurn({ userId, blockId: 'b3', variableId: CURRENT_TYPE, answer: 'Passport' });

  await conversationJournalService.replaceLatestAddressProofAnswer(userId, 'Driving Licence');

  const journal = await conversationJournalService.loadJournal(userId);
  assert.deepEqual(journal.map((entry) => entry.answer), ['Passport', 'https://s3/p.jpeg', 'Driving Licence']);
});

test('a member with no journal is a first-time member, not a resume', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  assert.equal(await conversationJournalService.countTurns(userId), 0);
  assert.deepEqual(await conversationJournalService.loadJournal(userId), []);
});

test('a journal write failure never costs the member their turn', async (t) => {
  // Stubbed rather than provoked with a bad id: App_Accounts_ChatJournal has no foreign key on
  // AccountId, so an unknown account inserts perfectly happily and would test nothing.
  const real = conversationJournalRepository.createTurn;
  conversationJournalRepository.createTurn = async () => {
    throw new Error('database is down');
  };
  t.after(() => { conversationJournalRepository.createTurn = real; });

  // Resume is a convenience; the answer the member just gave is not. A journal outage must cost
  // them the ability to resume past this point, never the turn itself.
  const result = await conversationJournalService.recordTurn({ userId: '1', blockId: 'b1', answer: 'x' });
  assert.equal(result, null);
});

test('a turn with no block id is not journalled', async () => {
  // Synthetic inputs (the OCR confirmation, the email OTP step, this feature's own resume prompt)
  // are not Typebot blocks, so there is nothing replayable about them.
  assert.equal(await conversationJournalService.recordTurn({ userId: '1', blockId: null, answer: 'x' }), null);
  assert.equal(await conversationJournalService.recordTurn({ userId: null, blockId: 'b1', answer: 'x' }), null);
});

// --- resume summary, driven end-to-end through handle() ---------------------
//
// "Here's what you told us earlier" is built from the DATABASE (registrationReviewService.
// buildReview), not the journal - those fields were already persisted the first time the member
// answered them, and replay never re-writes them. So these tests set up a real account with real
// columns filled in, journal a matching set of turns, then drive handle() exactly as a returning
// member's client would: an empty start call, then "Continue where I left off".

const texts = (res) =>
  (res.messages ?? []).map((m) => m.content?.richText?.[0]?.children?.[0]?.text ?? '').join(' || ');

function stubReplay(blockIds) {
  const real = { start: typebotClient.startChat, cont: typebotClient.continueChat };
  let position = 0;
  typebotClient.startChat = async () => ({ sessionId: 'resume-session', messages: [], input: { id: blockIds[0] } });
  typebotClient.continueChat = async () => {
    position += 1;
    const next = blockIds[position];
    return next ? { input: { id: next }, messages: [] } : { input: null, messages: [] };
  };
  return () => {
    typebotClient.startChat = real.start;
    typebotClient.continueChat = real.cont;
  };
}

test('resuming shows a summary of what was already told, read from the database', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  // These are exactly what saveConversationField would have written on the member's first visit -
  // buildReview() reads them straight from App_Accounts, not from anything journalled.
  await prisma.appAccounts.update({
    where: { AccountId: BigInt(userId) },
    data: {
      AccountEmail: 'resume-test@example.com',
      PlaceOfBirth: 'Banaras',
      RollTypeIds: '2,1', // Both
      AccountRegType: 'I',
    },
  });

  for (const blockId of ['b1', 'b2', 'b3']) {
    await conversationJournalService.recordTurn({ userId, blockId, answer: 'x' });
  }

  const restoreClient = stubReplay(['b1', 'b2', 'b3', 'b4']);
  t.after(restoreClient);

  const offer = await handle({ userId, token: 't' });
  assert.equal(offer.input?.id, 'resume-registration', 'a returning member is offered the choice first');

  const resumed = await handle({ userId, token: 't', message: 'Continue where I left off' });

  assert.match(texts(resumed), /Here's what you told us earlier/);
  assert.match(texts(resumed), /Email: resume-test@example\.com/);
  assert.match(texts(resumed), /Place of birth: Banaras/);
  assert.match(texts(resumed), /Applying as: \(Individual\) Author \/ Composer/);
  assert.match(texts(resumed), /Role: Both/);
  assert.match(texts(resumed), /Picking up where you left off/, "Typebot's own next question still follows");
  assert.equal(resumed.input?.id, 'b4');
});

test('conversation-only turns never fabricate a summary line that was not actually answered', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // makeAccount() always sets AccountMobile (that's how login works, before any chat question is
  // answered), and buildReview() lists it under "Your details" - so the summary is never LITERALLY
  // empty for a real member. What must hold is narrower: nothing the member never actually answered
  // shows up as if it had been.
  const userId = await makeAccount();

  // Pure navigation choices - "Yes", "I Accept" - carry no variableId, so nothing beyond the
  // pre-existing mobile number was ever persisted to a labelled column.
  for (const blockId of ['b1', 'b2']) {
    await conversationJournalService.recordTurn({ userId, blockId, answer: 'x' });
  }

  const restoreClient = stubReplay(['b1', 'b2', 'b3']);
  t.after(restoreClient);

  await handle({ userId, token: 't' });
  const resumed = await handle({ userId, token: 't', message: 'Continue where I left off' });

  assert.match(texts(resumed), /Here's what you told us earlier/, 'the account has a mobile number on file');
  assert.match(texts(resumed), /Mobile:/);
  for (const label of ['Email:', 'Stage name:', 'Place of birth:', 'Applying as:']) {
    assert.equal(texts(resumed).includes(label), false, `${label} was never answered and must not appear`);
  }
  assert.match(texts(resumed), /Picking up where you left off/);
});

test('an empty review is not rendered as an empty summary block', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  // Stubbed rather than found naturally, since a real account always has at least Mobile (see
  // above) - this pins the `sections.length` guard itself: buildReview() returning `[]` must mean
  // no summary message at all, not a "Here's what you told us earlier:" with nothing under it.
  const userId = await makeAccount();
  await conversationJournalService.recordTurn({ userId, blockId: 'b1', answer: 'x' });

  const realBuildReview = registrationReviewService.buildReview;
  registrationReviewService.buildReview = async () => [];
  const restoreClient = stubReplay(['b1', 'b2']);
  t.after(() => {
    restoreClient();
    registrationReviewService.buildReview = realBuildReview;
  });

  await handle({ userId, token: 't' });
  const resumed = await handle({ userId, token: 't', message: 'Continue where I left off' });

  assert.equal(/Here's what you told us earlier/.test(texts(resumed)), false);
  assert.match(texts(resumed), /Picking up where you left off/);
});

test('a summary that fails to build never blocks the resume itself', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();
  await prisma.appAccounts.update({ where: { AccountId: BigInt(userId) }, data: { AccountEmail: 'x@example.com' } });
  await conversationJournalService.recordTurn({ userId, blockId: 'b1', answer: 'x' });

  const realBuildReview = registrationReviewService.buildReview;
  registrationReviewService.buildReview = async () => {
    throw new Error('review service is down');
  };
  const restoreClient = stubReplay(['b1', 'b2']);
  t.after(() => {
    restoreClient();
    registrationReviewService.buildReview = realBuildReview;
  });

  await handle({ userId, token: 't' });
  const resumed = await handle({ userId, token: 't', message: 'Continue where I left off' });

  // The member still lands on the right question - a broken summary degrades gracefully, exactly
  // like every other "must never block the member" path in this engine.
  assert.equal(resumed.input?.id, 'b2');
  assert.match(texts(resumed), /Picking up where you left off/);
});

// --- "Start over" also clears previously saved work links -------------------
//
// Work links are append-only with a hard cap (MAX_WORK_LINKS in workLink.service.js), unlike
// documents or account fields. A tester found that restarting and adding just one new song still
// counted "2 of 5 links" and showed the old song too - because the original "Start over" only
// cleared the journal and the Typebot session, never App_Accounts_WorkRegistration. See
// registrationEngine.js's choosesRestart branch.

test('"Start over" clears previously saved work links, not just the journal', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  await workLinkService.saveWorkLink({
    userId,
    resolved: { provider: 'spotify', url: 'https://open.spotify.com/track/old', songName: 'Old Song', artists: ['Someone'], credits: ['Someone'] },
    matched: true,
  });
  assert.equal(await workLinkService.countWorkLinks(userId), 1, 'sanity: the old song is there before restarting');

  await conversationJournalService.recordTurn({ userId, blockId: 'b1', answer: 'x' });

  const realStart = typebotClient.startChat;
  t.after(() => { typebotClient.startChat = realStart; });
  typebotClient.startChat = async () => ({ sessionId: 'fresh-session', messages: [], input: { id: 'q1' } });

  await handle({ userId, token: 't' }); // the resume offer
  const restarted = await handle({ userId, token: 't', message: 'Start over' });

  assert.equal(restarted.input?.id, 'q1', 'a genuinely fresh chat, not the resume offer again');
  assert.equal(await workLinkService.countWorkLinks(userId), 0, 'the old song must not survive a restart');
  assert.equal(await conversationJournalService.countTurns(userId), 0);
});

test('"Start over" does not touch another member\'s work links', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const restarting = await makeAccount();
  const untouched = await makeAccount();

  for (const userId of [restarting, untouched]) {
    await workLinkService.saveWorkLink({
      userId,
      resolved: { provider: 'spotify', url: `https://open.spotify.com/track/${userId}`, songName: 'Song', artists: ['A'], credits: ['A'] },
      matched: true,
    });
  }
  await conversationJournalService.recordTurn({ userId: restarting, blockId: 'b1', answer: 'x' });

  const realStart = typebotClient.startChat;
  t.after(() => { typebotClient.startChat = realStart; });
  typebotClient.startChat = async () => ({ sessionId: 'fresh-session', messages: [], input: { id: 'q1' } });

  await handle({ userId: restarting, token: 't' });
  await handle({ userId: restarting, token: 't', message: 'Start over' });

  assert.equal(await workLinkService.countWorkLinks(restarting), 0);
  assert.equal(await workLinkService.countWorkLinks(untouched), 1, "a different member's song must survive");
});
