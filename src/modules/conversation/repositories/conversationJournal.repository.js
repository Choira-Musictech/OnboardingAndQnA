// ==================================================================
// App_Accounts_ChatJournal repository - the ordered record of every
// answer Typebot accepted, used to resume an abandoned registration.
// Data access only.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

function findByAccountId(accountId) {
  return prisma.appAccountsChatJournal.findMany({
    where: { AccountId: BigInt(accountId) },
    orderBy: { TurnIndex: 'asc' },
  });
}

function countByAccountId(accountId) {
  return prisma.appAccountsChatJournal.count({ where: { AccountId: BigInt(accountId) } });
}

// The next turn index for this member. Replay depends on there being no holes and no duplicates, so
// the index is derived from what is actually stored rather than from a counter held in memory - the
// session store is wiped by a restart, and a resumed conversation has to keep appending to the same
// journal it just replayed.
async function nextTurnIndex(accountId) {
  const last = await prisma.appAccountsChatJournal.findFirst({
    where: { AccountId: BigInt(accountId) },
    orderBy: { TurnIndex: 'desc' },
    select: { TurnIndex: true },
  });
  return last ? last.TurnIndex + 1 : 0;
}

function createTurn(data) {
  return prisma.appAccountsChatJournal.create({ data });
}

function deleteByAccountId(accountId) {
  return prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: BigInt(accountId) } });
}

// Drops every turn from `turnIndex` onwards. Used when a replay stops early: the turns past that
// point describe a flow the member is no longer on, and leaving them would put a gap of wrong
// answers in the middle of the journal that the NEXT resume would faithfully replay.
function deleteFromTurnIndex(accountId, turnIndex) {
  return prisma.appAccountsChatJournal.deleteMany({
    where: { AccountId: BigInt(accountId), TurnIndex: { gte: turnIndex } },
  });
}

// Rewrites the answer of the newest turn that answered one of `variableIds`. Returns the updated row,
// or null when no such turn exists.
async function updateLatestAnswerForVariables(accountId, variableIds, answer) {
  const latest = await prisma.appAccountsChatJournal.findFirst({
    where: { AccountId: BigInt(accountId), VariableId: { in: variableIds } },
    orderBy: { TurnIndex: 'desc' },
    select: { JournalId: true },
  });
  if (!latest) return null;
  return prisma.appAccountsChatJournal.update({ where: { JournalId: latest.JournalId }, data: { Answer: answer } });
}

export const conversationJournalRepository = {
  findByAccountId,
  countByAccountId,
  nextTurnIndex,
  createTurn,
  deleteByAccountId,
  deleteFromTurnIndex,
  updateLatestAnswerForVariables,
};
