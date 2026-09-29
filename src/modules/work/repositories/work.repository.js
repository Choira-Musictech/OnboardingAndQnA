// ==================================================================
// App_Accounts_WorkRegistration repository - the songs a member claims
// as their own. Data access only.
//
// Moved here from modules/spotify: the table holds work links from any
// provider (Spotify or YouTube), so it no longer belongs to the Spotify
// module. modules/spotify keeps its API client and claim service.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

function createWorkRegistration(data) {
  return prisma.appAccountsWorkRegistration.create({ data });
}

function countByAccountId(accountId) {
  return prisma.appAccountsWorkRegistration.count({
    where: { AccountId: BigInt(accountId) },
  });
}

// Oldest first, so the pre-payment review lists the member's songs in the order they added them.
function findByAccountId(accountId) {
  return prisma.appAccountsWorkRegistration.findMany({
    where: { AccountId: BigInt(accountId) },
    orderBy: { WorkNotificationId: 'asc' },
  });
}

function deleteByAccountId(accountId) {
  return prisma.appAccountsWorkRegistration.deleteMany({ where: { AccountId: BigInt(accountId) } });
}

// Used by the post-link-loop WorkCategory/LanguageNames/ReleaseYear follow-up (workDetailsGate.js) -
// each answer is written to its own row as soon as it's given, not batched.
function updateWorkRegistration(workNotificationId, data) {
  return prisma.appAccountsWorkRegistration.update({
    where: { WorkNotificationId: BigInt(workNotificationId) },
    data,
  });
}

// Duplicate-link check: DigitalLink already holds the provider's own canonical/normalized URL by
// the time a row is written, so an exact match against it is a reliable "same song, same member".
function existsByAccountIdAndDigitalLink(accountId, digitalLink) {
  return prisma.appAccountsWorkRegistration.findFirst({
    where: { AccountId: BigInt(accountId), DigitalLink: digitalLink },
    select: { WorkNotificationId: true },
  });
}

export const workRepository = {
  createWorkRegistration,
  countByAccountId,
  findByAccountId,
  deleteByAccountId,
  existsByAccountIdAndDigitalLink,
  updateWorkRegistration,
};
