// ==================================================================
// Registration repository - data access only.
// Registration state is read from App_Accounts.ApplicationStatus
// (1 = fully registered). Section-based Typebot persistence writes
// App_Accounts fields directly and App_Accounts_Doc rows for documents.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

function findByAccountId(accountId) {
  return prisma.appAccounts.findUnique({ where: { AccountId: BigInt(accountId) } });
}

// Emails are stored lowercase (see saveConversationField), so the caller passes an already
// normalized value. findFirst rather than findUnique: the uniqueness lives in a filtered index that
// Prisma's schema can't express, so the client doesn't know the column is unique.
function findByAccountEmail(email) {
  return prisma.appAccounts.findFirst({
    where: { AccountEmail: email },
    select: { AccountId: true },
  });
}

function markCompleted(accountId) {
  return prisma.appAccounts.update({
    where: { AccountId: BigInt(accountId) },
    data: { ApplicationStatus: 1, Detail10: 'choira', RecordStatus: 1 },
  });
}

function update(accountId, data) {
  return prisma.appAccounts.update({ where: { AccountId: BigInt(accountId) }, data });
}

// `DocumentName` holds the document type ("PAN"), `DocumentCaption` holds the S3 URL - see
// AGENTS.md. App_Accounts_Doc has no unique constraint on (AccountId, DocumentName), so a
// re-upload is handled as a manual find-then-update-or-create rather than a native
// Prisma upsert (which requires a unique/id field to match on).
async function upsertDocument({ accountId, caption, documentUrl, docStatus = 0, docFileName = null, documentLookupId = null, createdBy = null }) {
  const existing = await prisma.appAccountsDoc.findFirst({
    where: { AccountId: BigInt(accountId), DocumentName: caption },
  });

  // DocumentLookupId is BigInt? in the schema - wrap it like AccountId. Overwritten unconditionally
  // on every save (including a re-upload) so a stale id/null never survives a later, better-resolved
  // save - same treatment as DocFileName/DocumentCaption below.
  const documentLookupIdValue = documentLookupId != null ? BigInt(documentLookupId) : null;

  if (existing) {
    return prisma.appAccountsDoc.update({
      where: { AccountDocId: existing.AccountDocId },
      data: {
        DocumentCaption: documentUrl,
        DocStatus: docStatus,
        DocFileName: docFileName,
        DocumentLookupId: documentLookupIdValue,
        ModifedDate: new Date(),
        ...(createdBy ? { ModifedBy: createdBy } : {}),
      },
    });
  }

  return prisma.appAccountsDoc.create({
    data: {
      AccountId: BigInt(accountId),
      DocumentName: caption,
      DocumentCaption: documentUrl,
      DocStatus: docStatus,
      DocFileName: docFileName,
      DocumentLookupId: documentLookupIdValue,
      ...(createdBy ? { CreatedBy: createdBy, ModifedBy: createdBy } : {}),
    },
  });
}

function findDocumentsByAccountId(accountId) {
  return prisma.appAccountsDoc.findMany({ where: { AccountId: BigInt(accountId) } });
}

export const registrationRepository = {
  findByAccountId,
  findByAccountEmail,
  markCompleted,
  update,
  upsertDocument,
  findDocumentsByAccountId,
};
