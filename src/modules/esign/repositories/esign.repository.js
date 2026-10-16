// ==================================================================
// E-sign repository - data access only.
// App_Accounts_ESign holds one row per signing attempt (see scripts/add-esign-table.sql);
// Doc_LookUp gives IPRS's own long names for the documents listed on the application form.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

// DocumentLookupId -> IPRS's own name for it ("Identity Proof (Pan Card)."). Empty on a dev DB
// that never imported Doc_LookUp - the caller falls back to its own labels.
async function findDocumentLookupNames(lookupIds) {
  const ids = [...new Set(lookupIds.filter((id) => id != null).map((id) => BigInt(id)))];
  if (!ids.length) return new Map();
  const rows = await prisma.docLookUp.findMany({
    where: { DocumentLookupId: { in: ids } },
    select: { DocumentLookupId: true, DocumentName: true },
  });
  return new Map(rows.map((row) => [String(row.DocumentLookupId), row.DocumentName]));
}

function createSigning({ accountId, provider, status, unsignedPdfPath = null }) {
  return prisma.appAccountsESign.create({
    data: { AccountId: BigInt(accountId), Provider: provider, Status: status, UnsignedPdfPath: unsignedPdfPath },
  });
}

function updateSigning(eSignId, data) {
  return prisma.appAccountsESign.update({
    where: { ESignId: BigInt(eSignId) },
    data: { ModifedDate: new Date(), ...data },
  });
}

function findSigningById(eSignId) {
  return prisma.appAccountsESign.findUnique({ where: { ESignId: BigInt(eSignId) } });
}

// The member's most recent attempt, whatever its status.
function findLatestSigning(accountId) {
  return prisma.appAccountsESign.findFirst({
    where: { AccountId: BigInt(accountId) },
    orderBy: { ESignId: 'desc' },
  });
}

// A member may have more than one attempt (an older link can still be signed after a newer one was
// started) - any completed one means the form is signed.
function findCompletedSigning(accountId) {
  return prisma.appAccountsESign.findFirst({
    where: { AccountId: BigInt(accountId), Status: 'COMPLETED' },
    orderBy: { ESignId: 'desc' },
  });
}

async function hasCompletedSigning(accountId) {
  return Boolean(await findCompletedSigning(accountId));
}

export const esignRepository = {
  findDocumentLookupNames,
  createSigning,
  updateSigning,
  findSigningById,
  findLatestSigning,
  findCompletedSigning,
  hasCompletedSigning,
};
