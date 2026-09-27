// ==================================================================
// Registration service - business logic for the onboarding status
// and for the Typebot-driven, section-based registration flow.
// Status is derived from App_Accounts.ApplicationStatus (1 = done).
// ==================================================================
import { appError, badRequestError, forbiddenError, notFoundError } from '../../../shared/errors.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { prisma } from '../../../shared/prisma.js';
import { registrationRepository } from '../repositories/registration.repository.js';
import { createOcrProvider } from './ocr/ocrProvider.factory.js';
import { paymentRepository } from '../../payment/repositories/payment.repository.js';
import {
  PUBLISHER_ROLL_TYPE_ID_BY_REG_TYPE,
  resolveEntityType,
  resolveRegType,
  resolveRollTypeIds,
} from './memberRoleCodes.js';
import { languageLookupService } from './languageLookup.service.js';
import { DOC_LOOKUP_ID_BY_PATH } from './documentLookupMap.js';

const REGISTERED = 1;
const DOC_TYPES = Object.freeze({
  PAN: 'PAN',
  AADHAAR: 'AADHAAR', // no longer collected by the live flow (replaced by address-proof below) -
  // kept for back-compat, still usable via a direct REST call.
  BANK: 'BANK',
  NOC: 'NOC',
  COMPANY_DOC: 'COMPANY_DOC',
  PROFILE_PHOTO: 'PROFILE_PHOTO',
  // Generic "address proof" upload slots (permanent/current) - the live flow lets the user pick
  // one of 5 document types (Passport/Electricity Bill/Driving Licence/Voter ID/Letter from
  // Property Owner) for each, but always uploads into one of these two shared variables. Which
  // type was picked is routed to OCR conditionally - see addressProofTypeMap.js.
  PERMANENT_ADDRESS_PROOF: 'PERMANENT_ADDRESS_PROOF',
  CURRENT_ADDRESS_PROOF: 'CURRENT_ADDRESS_PROOF',
  // OCR-only doc types reachable via PERMANENT_ADDRESS_PROOF/CURRENT_ADDRESS_PROOF/
  // REGISTERED_ADDRESS_PROOF/COMM_ADDRESS_PROOF_2 uploads when the user picked one of these as
  // their address-proof type - never a stored document type on their own, only ever passed as
  // saveDocument()'s ocrDocType override. "Letter from Property Owner"/"Telephone Bill"/
  // "Mobile Bill"/"Rent Agreement" have no matching OCR endpoint anywhere and stay unmapped.
  DRIVING_LICENCE: 'DRIVING_LICENCE',
  VOTER_ID: 'VOTER_ID',
  PASSPORT: 'PASSPORT',
  ELECTRICITY: 'ELECTRICITY',
  // GST Certificate, chosen as an address-proof type on the company/NRI paths - see
  // addressProofTypeMap.js. Confirmed live: POST /api/documents/gst returns legalName/gstin/
  // address/pincode for a real certificate.
  GST: 'GST',
  // (NRI) Author/Composer path uploads - all save-only, no OCR endpoint exists for any of these
  // (same treatment as NOC/COMPANY_DOC).
  TRC: 'TRC',
  SS_NUMBER: 'SS_NUMBER',
  FORM_41: 'FORM_41',
  TIN: 'TIN',
  SELF_DECLARATION: 'SELF_DECLARATION',
  // (NRI) Owner/Publisher path uploads - also all save-only. The 3 address slots below can still
  // receive an ocrDocType override from their paired type-choice question (see addressProofTypeMap.js),
  // same mechanism as PERMANENT_ADDRESS_PROOF/CURRENT_ADDRESS_PROOF above.
  COMPANY_PHOTO: 'COMPANY_PHOTO',
  PEC: 'PEC',
  ENTITY_INCORPORATION: 'ENTITY_INCORPORATION',
  COMPANY_TRC: 'COMPANY_TRC',
  LETTER: 'LETTER',
  REGISTERED_ADDRESS_PROOF: 'REGISTERED_ADDRESS_PROOF',
  COMM_ADDRESS_PROOF: 'COMM_ADDRESS_PROOF',
  COMM_ADDRESS_PROOF_2: 'COMM_ADDRESS_PROOF_2',
  // Owner/Publisher path. COMPANY_PAN is OCR'd as a PAN (see OCR_TYPE_BY_DOC_TYPE); the rest are
  // save-only - no OCR endpoint exists for any of them. MOA_AOA/BOARD_RESOLUTION/COMPANY_NOC are
  // Corporate-only, PARTNERSHIP_DEED/AUTHORITY_LETTER Partnership-only, TUM Sole-Proprietorship-only.
  COMPANY_PAN: 'COMPANY_PAN',
  GST_CERTIFICATE: 'GST_CERTIFICATE',
  MOA_AOA: 'MOA_AOA',
  BOARD_RESOLUTION: 'BOARD_RESOLUTION',
  COMPANY_NOC: 'COMPANY_NOC',
  PARTNERSHIP_DEED: 'PARTNERSHIP_DEED',
  AUTHORITY_LETTER: 'AUTHORITY_LETTER',
  TUM: 'TUM',
});

// Doc types that are OCR'd as a *different* type than they're stored under. Unlike the address
// proofs - whose type comes from a preceding choice question, stashed per-session - this is static:
// a company PAN is always OCR'd as a PAN (writing Detail2), while the row keeps the honest
// COMPANY_PAN caption so a human reviewer can tell the two apart.
// Exported because the conversation engine has to apply the same mapping when it labels the
// OCR-confirmation card - it only knows the stored docType, and looking up COMPANY_PAN in
// OCR_FIELD_LABELS found nothing, so the card listed no fields at all.
export const OCR_TYPE_BY_DOC_TYPE = { COMPANY_PAN: 'PAN', GST_CERTIFICATE: 'GST' };
// What gates /complete - NOC/COMPANY_DOC/PROFILE_PHOTO/CURRENT_ADDRESS_PROOF are
// conditional/optional in the flow. Each entry is satisfied by *any one* of its types, because the
// same real-world requirement is collected under a different doc type on each role path: an
// individual uploads PAN and PERMANENT_ADDRESS_PROOF, a company uploads COMPANY_PAN and
// REGISTERED_ADDRESS_PROOF. Requiring the individual names outright made completion impossible on
// the three company/NRI paths - complete() threw REGISTRATION_INCOMPLETE forever, so
// ApplicationStatus never reached 1 and the territory fallback below never fired.
// PERMANENT_ADDRESS_PROOF replaces AADHAAR as the individual address-proof step - the live flow
// never asks for Aadhaar specifically anymore. COMM_ADDRESS_PROOF* are deliberately excluded: they
// are the secondary correspondence address, not proof of the primary one.
const REQUIRED_DOC_GROUPS = [
  {
    // Proof of identity / tax registration. An Indian individual gives a PAN, a company its
    // COMPANY_PAN, and an NRI - who often has no Indian PAN at all - a PASSPORT and/or the foreign
    // TIN that stands in for one (observed on a live NRI Author/Composer run: PROFILE_PHOTO,
    // PASSPORT, TRC, BANK, PERMANENT_ADDRESS_PROOF, TIN, SELF_DECLARATION - no PAN anywhere).
    label: 'identity',
    types: [DOC_TYPES.PAN, DOC_TYPES.COMPANY_PAN, DOC_TYPES.PASSPORT, DOC_TYPES.TIN],
  },
  { label: 'bank', types: [DOC_TYPES.BANK] },
  {
    label: 'address-proof',
    types: [DOC_TYPES.PERMANENT_ADDRESS_PROOF, DOC_TYPES.REGISTERED_ADDRESS_PROOF],
  },
];
// OCR runs for these - NOC/company docs/profile photos/address-proof-with-an-unsupported-type are
// saved as-is. PROFILE_PHOTO's passport-photo endpoint was briefly wired in but is not currently
// working - reverted, see AGENTS.md. PASSPORT is live again - the provider-side
// issues that had it disabled are fixed (re-verified against the running service: it reads the MRZ
// and rejects a document of the wrong type). It matters more than the others - on the NRI paths the
// passport IS the identity document, so it was the one required document with no check at all.
// Exported so a test can assert every OCR'd type has confirmation labels - see ocrLabels.test.js.
export const OCR_DOC_TYPES = [
  DOC_TYPES.PAN,
  DOC_TYPES.AADHAAR,
  DOC_TYPES.BANK,
  DOC_TYPES.DRIVING_LICENCE,
  DOC_TYPES.VOTER_ID,
  DOC_TYPES.ELECTRICITY,
  DOC_TYPES.PASSPORT,
  DOC_TYPES.GST,
];
// Doc types whose OCR `name` is trustworthy enough to become AccountName. Address proofs are
// excluded on purpose: an electricity bill or a rent letter routinely carries someone else's name -
// GST is the one exception: its `legalName` is the registered entity's own name (same company as
// COMPANY_PAN, not a landlord/relative), read from a government registration document.
const IDENTITY_OCR_DOC_TYPES = [DOC_TYPES.PAN, DOC_TYPES.AADHAAR, DOC_TYPES.PASSPORT, DOC_TYPES.GST];
// AppAccounts has no dedicated PAN/Aadhaar-number columns at all - PAN goes to the generic
// Detail2 column (which IPRS's real schema already has), and the Aadhaar OCR result is used for
// verification only. Bank OCR maps onto its existing columns.
const BANK_FIELD_MAP = { bankName: 'BankName', accountNumber: 'BankAcNo', ifsc: 'BankIFSCCode', branch: 'BankBranchName', micr: 'MicrCode' };
// Which AppAccounts column an OCR-extracted `address` goes to, keyed by the upload slot (the
// original docType, before any ocrDocType override). Base column = permanent/registered address,
// `_PR` suffix = current/communication address (user-confirmed mapping, see AGENTS.md).
// COMM_ADDRESS_PROOF is deliberately absent: its choice list is entity-existence documents
// (MOA/Incorporation Certificate/Board Resolution/Trade License/Letter from Bank), not an address.
const ADDRESS_COLUMN_BY_SLOT = {
  [DOC_TYPES.PERMANENT_ADDRESS_PROOF]: 'AccountAddress',
  [DOC_TYPES.CURRENT_ADDRESS_PROOF]: 'AccountAddress_PR',
  [DOC_TYPES.REGISTERED_ADDRESS_PROOF]: 'AccountAddress',
  [DOC_TYPES.COMM_ADDRESS_PROOF_2]: 'AccountAddress_PR',
};
// Each address column's paired pincode column - AccountAddress/AccountAddress_PR always travel
// together (same permanent-vs-current split), so whichever one gets written, its pincode sibling
// does too.
const PINCODE_COLUMN_BY_ADDRESS_COLUMN = { AccountAddress: 'Pincode', AccountAddress_PR: 'Pincode_PR' };

// App_Accounts.BookId - IPRS's own dbo.GetStateBookId SQL function (confirmed live on mraai_uat)
// already encodes the real zone/category logic, including a quirk that isn't derivable from data
// alone: NRI categories (NI/NC) don't zone-match by state at all, they're hardcoded to the West
// NRI book. Rather than re-deriving that in JS (and risking getting quirks like this wrong), this
// runs their exact reference query per AccountId - it reads AccountRegType/Pincode off the row
// itself, so no other args are needed. Both AccountRegType and the permanent address/pincode can
// be answered in either order by the flow, so this is called after either one is written - same
// re-derivation pattern copyPermanentAddressToCurrent already uses.
async function resolveAndPersistBookId(registrationId) {
  const rows = await prisma.$queryRaw`
    SELECT dbo.GetStateBookId(AG.GroupId, AA.AccountRegType) AS BookId
    FROM App_Accounts AA
    CROSS APPLY (
      SELECT TOP 1 GroupId FROM App_Geographical
      WHERE GeographicalCode = CAST(AA.Pincode AS VARCHAR(20))
    ) AG
    WHERE AA.AccountId = ${BigInt(registrationId)}
  `;
  const bookId = rows[0]?.BookId;
  if (bookId == null) return;
  await registrationRepository.update(registrationId, { BookId: bookId });
}

// Neither OCR nor a manually-typed address gives us a separate pincode field - just one flat
// address string. Indian PIN codes are 6 digits, first digit 1-9, and sit at the end of a full
// address, so take the LAST standalone match rather than the first (a house/flat number earlier in
// the string could otherwise be mistaken for one).
function extractPincode(address) {
  if (typeof address !== 'string') return null;
  const matches = address.match(/\b[1-9]\d{5}\b/g);
  return matches?.length ? matches[matches.length - 1] : null;
}
// Fields conversationFieldMap.js is allowed to write to - keeps an arbitrary
// mapped column name from being trusted blindly, even though the map only
// ever contains these three today.
const CONVERSATION_FIELDS = [
  'Detail1', // GST number

  'AccountAlias',
  'AccountEmail',
  'PlaceOfBirth',
  'RollTypeIds',
  'AccountRegType',
  'TeritoryAppFor',
  'Nationality',
  'AssociationName_India',
  'DualNationality',
  'AccountAddress',
  'AccountAddress_PR',
  'ChanlDesc',
  'KindAttention1',
  'EntityType',
  'LanguageName', // mother tongue - also resolves LanguageId, see saveConversationField
  'TRCNo', // Tax Residency Certificate number (NRI paths)
  'Consent', // "I Accept" x2 - special-cased below, the answer text itself is never stored
];

// Exported (not just a local const) so tests can swap ocrProvider.extract, same technique
// verifyGate.js's verifyProvider export uses.
export const ocrProvider = createOcrProvider();

// The names a song's credits are checked against, split by how much they're worth as evidence.
//
// `trusted` are names on file *before* the member ever saw a song's credits: AccountName (written
// from their identity document, see runOcrAndPersist) and AccountAlias (the stage name asked during
// registration). `claimed` are names the member supplied at the work-link step - i.e. after we
// showed them the credit list - so a match against one of those is a claim, not a check, and the
// work link is stored unverified. See AGENTS.md.
async function getIdentityNames(userId) {
  const account = await registrationRepository.findByAccountId(userId);
  if (!account) throw notFoundError('User not found');

  // AccountAlias may hold several comma-separated names by now (see addAliases). Position, not a
  // Source column, is what makes them trusted or claimed: the first entry is whatever the flow's
  // own stage-name/traderName question wrote (see conversationFieldMap.js), on file before the
  // member ever saw a song's credits - the same standing as AccountName. Everything after it was
  // added later via addAliases, i.e. a claim made *after* seeing the credits.
  const [flowAlias, ...claimedAliases] = splitAliasList(account.AccountAlias);

  return {
    accountName: account.AccountName,
    accountAlias: account.AccountAlias,
    trusted: [account.AccountName, flowAlias].filter((name) => name?.trim()),
    claimed: claimedAliases,
  };
}

async function getStatus(userId) {
  const account = await registrationRepository.findByAccountId(userId);
  if (!account) throw notFoundError('User not found');
  return toPublic(account);
}

// The registrationId param must match the authenticated user - the id alone is
// never sufficient to touch another user's registration.
function assertOwnRegistration(userId, registrationId) {
  if (String(registrationId) !== String(userId)) {
    throw forbiddenError('Registration does not belong to the authenticated user');
  }
}

// App_Accounts_Doc.DocFileName was always left NULL by this app - prod actually uses it (confirmed
// against mraai_uat: real rows hold the uploaded file's own name). The URL is a Typebot-generated
// S3 key, not user-facing, so this pulls out just the last path segment. DocFileName is
// NVarChar(100), so a long name is truncated rather than failing the write.
function extractFileName(documentUrl) {
  if (!documentUrl) return null;
  try {
    const path = new URL(documentUrl).pathname;
    const name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    return name ? name.slice(0, 100) : null;
  } catch {
    return null;
  }
}

// AccountRegType I/NI/NC map straight to a Doc_LookUp path key; C additionally needs EntityType,
// since IPRS's Doc_LookUp has separate document sets per entity type (Sole Proprietor/Partnership/
// Corporate) - see documentLookupMap.js. Returns null when there isn't yet a confident path (e.g.
// the entity-type question hasn't been answered).
export function resolveDocPathKey(account) {
  const regType = account.AccountRegType;
  if (regType === 'C') {
    if (account.EntityType === 'SP') return 'C_SP';
    if (account.EntityType === 'PR') return 'C_PR';
    if (account.EntityType === 'CP') return 'C_CP';
    return null;
  }
  return ['I', 'NI', 'NC'].includes(regType) ? regType : null;
}

// MRU_<AccountId>_<DocumentLookupId>_N1_<filename> - IPRS's own DocFileName convention (confirmed
// against mraai_uat). Only applied when a real DocumentLookupId was resolved; otherwise this is the
// same plain filename extractFileName() alone would produce (today's unchanged fallback). The
// prefix competes with extractFileName's own 100-char slice for the NVarChar(100) budget, so the
// filename is truncated by however much room the prefix actually used, not by a fixed guess.
export function buildDocFileName(accountId, documentLookupId, documentUrl) {
  const plain = extractFileName(documentUrl);
  if (!plain || documentLookupId == null) return plain;

  const prefix = `MRU_${accountId}_${documentLookupId}_N1_`;
  const budget = 100 - prefix.length;
  if (budget <= 0) return plain.slice(0, 100);

  return prefix + plain.slice(0, budget);
}

// AppAccounts.AccountImage is NVarChar(100) - too short for a real photo URL, so this mirrors
// prod's own convention (confirmed against mraai_uat) instead of a truncated, broken link. The
// actual openable URL stays in App_Accounts_Doc.DocumentCaption, untouched.
export function buildAccountImagePath(accountId, documentUrl) {
  // IPRS's own convention is underscores throughout, but the original filename (a WhatsApp export,
  // a phone's camera roll name) often carries hyphens instead - normalize before building the path.
  const plain = extractFileName(documentUrl)?.replaceAll('-', '_');
  if (!plain) return null;

  const prefix = `MemberPhoto/MPU_${accountId}_`;
  const budget = 100 - prefix.length;
  if (budget <= 0) return plain.slice(0, 100);

  return prefix + plain.slice(0, budget);
}

// `ocrDocType` lets a caller run OCR under a different type than the one being saved on the row -
// used for PERMANENT_ADDRESS_PROOF/CURRENT_ADDRESS_PROOF uploads, where the DB row stays generic
// but the actual document might be a Driving Licence or Voter ID (see addressProofTypeMap.js).
async function saveDocument(userId, registrationId, docType, documentUrl, ocrDocType) {
  assertOwnRegistration(userId, registrationId);

  const account = await registrationRepository.findByAccountId(registrationId);
  if (!account) throw notFoundError('Registration not found');

  const effectiveOcrType = ocrDocType ?? OCR_TYPE_BY_DOC_TYPE[docType] ?? docType;
  const ocrResult = env.OCR_ENABLED && OCR_DOC_TYPES.includes(effectiveOcrType)
    ? await runOcrAndPersist(registrationId, effectiveOcrType, documentUrl, docType)
    : null;

  // DocStatus: 0 = no OCR attempted (NOC/COMPANY_DOC/PROFILE_PHOTO), 1 = OCR-verified, 2 = OCR failed.
  const docStatus = ocrResult ? (ocrResult.verified ? 1 : 2) : 0;

  const pathKey = resolveDocPathKey(account);
  const documentLookupId = pathKey ? DOC_LOOKUP_ID_BY_PATH[pathKey]?.[docType] ?? null : null;

  const doc = await registrationRepository.upsertDocument({
    accountId: registrationId,
    caption: docType,
    documentUrl,
    docStatus,
    documentLookupId,
    docFileName: buildDocFileName(registrationId, documentLookupId, documentUrl),
  });

  if (docType === DOC_TYPES.PROFILE_PHOTO) {
    await registrationRepository.update(registrationId, {
      AccountImage: buildAccountImagePath(registrationId, documentUrl),
    });
  }

  return toDocumentPublic(doc, ocrResult);
}

// Persists a single text/choice conversation answer (GST number, alias/stage
// name, email) onto its mapped AppAccounts column - see conversationFieldMap.js.
async function saveConversationField(userId, registrationId, field, value) {
  assertOwnRegistration(userId, registrationId);
  if (!CONVERSATION_FIELDS.includes(field)) return;

  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return;

  let update;
  if (field === 'DualNationality') {
    // DB column is Int/TinyInt, not text - the chat answer is a Yes/No choice.
    const normalized = trimmed.toLowerCase();
    if (normalized !== 'yes' && normalized !== 'no') return;
    update = { DualNationality: normalized === 'yes' ? 1 : 0 };
  } else if (field === 'AccountEmail') {
    // Stored lowercase so "A@B.com" and "a@b.com" can't become two accounts regardless of the
    // column's collation - the unique index can only enforce what's actually written.
    update = { AccountEmail: normalizeEmail(trimmed) };
  } else if (field === 'AccountRegType') {
    // The answer text is not what goes in the column - IPRS's own code (I/NI/C/NC) is.
    const regType = resolveRegType(trimmed);
    if (!regType) return;
    update = { AccountRegType: regType };
    // The publisher paths never reach the role question, so their RollTypeIds is decided here.
    const publisherRoll = PUBLISHER_ROLL_TYPE_ID_BY_REG_TYPE[regType];
    if (publisherRoll) update.RollTypeIds = publisherRoll;
  } else if (field === 'EntityType') {
    // Their column is a 2-letter code (CP/PR/SP), not the answer text.
    const entityType = resolveEntityType(trimmed);
    if (!entityType) return;
    update = { EntityType: entityType };
  } else if (field === 'RollTypeIds') {
    // Which ids the role maps to depends on the path chosen earlier (individual vs NRI), so the
    // reg type has to be read back first. Without it there's nothing safe to write - better to
    // skip than to store the answer text in a column that holds lookup ids.
    const account = await registrationRepository.findByAccountId(registrationId);
    const ids = resolveRollTypeIds(account?.AccountRegType, trimmed);
    if (!ids) return;
    update = { RollTypeIds: ids };
  } else if (field === 'LanguageName') {
    // Unlike RollTypeIds/EntityType/AccountRegType, this one really is free text - see
    // languageLookup.service.js. The member's own words always get stored; LanguageId only on a
    // confident match against IPRS's App_Language_Lookup, never guessed.
    update = { LanguageName: trimmed, LanguageId: await languageLookupService.resolveLanguageId(trimmed) };
  } else if (field === 'AccountAddress' || field === 'AccountAddress_PR') {
    update = { [field]: trimmed };
    const pincode = extractPincode(trimmed);
    if (pincode) update[PINCODE_COLUMN_BY_ADDRESS_COLUMN[field]] = pincode;
  } else if (field === 'Consent') {
    // Single-choice "I Accept", no reject option - the answer text carries no information beyond
    // "this block was reached", and reaching it means both consent blocks were accepted (see
    // conversationFieldMap.js's comment on this variableId).
    update = { Consent: 1, ConsentDate: new Date() };
  } else {
    update = { [field]: trimmed };
  }

  await registrationRepository.update(registrationId, update);

  // BookId depends on AccountRegType and the permanent address's Pincode, answerable in either
  // order by the flow - re-resolve after whichever one just landed (AccountAddress_PR is the
  // current/communication address, not the permanent one dbo.GetStateBookId's query reads).
  // This is a best-effort follow-up, not part of saving the answer itself - a failure here (e.g.
  // dbo.GetStateBookId missing on a deployed DB - confirmed live) must never fail the chat answer
  // that was just saved above.
  if (field === 'AccountRegType' || field === 'AccountAddress') {
    try {
      await resolveAndPersistBookId(registrationId);
    } catch (err) {
      logger.warn({ registrationId, err }, 'Could not resolve BookId, continuing without it');
    }
  }
}

// "Is your current address the same as your permanent address?" - Typebot's own choice-input
// block for this carries no variableId (nothing observes the answer today), so registrationEngine
// calls this directly by block id when the member answers "Yes". Copies both the address and its
// pincode - the two always travel together (see PINCODE_COLUMN_BY_ADDRESS_COLUMN).
async function copyPermanentAddressToCurrent(userId) {
  const account = await registrationRepository.findByAccountId(userId);
  if (!account?.AccountAddress?.trim()) return;

  await registrationRepository.update(userId, {
    AccountAddress_PR: account.AccountAddress,
    ...(account.Pincode ? { Pincode_PR: account.Pincode } : {}),
  });
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// True only when the email already belongs to a *different* account. The chat's email step calls
// this before sending an OTP (see registrationEngine.js) so a member is told the address is taken
// instead of being walked through a verification that could never be saved. The filtered unique
// index on App_Accounts(AccountEmail) is the actual guarantee; this is for the message.

// Bounds on a single work-link "what are you credited under" answer, so a pasted paragraph can't
// fill AccountAlias. MAX_ALIAS_LENGTH also protects the column itself (NVarChar(200)) from a lone
// name that's too long to ever fit.
const MAX_ALIASES_PER_TURN = 5;
const MAX_ALIAS_LENGTH = 200;
// AccountAlias's own column width - the hard ceiling on the comma-joined list as a whole, not just
// one name. A table never needed this; a single column does.
const ALIAS_COLUMN_MAX_LENGTH = 200;

// Splits a free-text answer into individual names, bounded to what a single turn may add. The
// work-link step tells members they may give more than one, separated by commas.
export function parseAliasList(value) {
  return String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= MAX_ALIAS_LENGTH)
    .slice(0, MAX_ALIASES_PER_TURN);
}

// Splits AccountAlias back into the names already stored there - no per-turn cap, since the column
// can hold more than MAX_ALIASES_PER_TURN once several turns have each added a few.
function splitAliasList(value) {
  return String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

// Stores the names a member says they're credited under, so their next link matches without asking
// again. Appended to AccountAlias itself (position matters - see getIdentityNames): the flow's own
// stage-name/traderName question always runs first and plainly overwrites this column (see
// conversationFieldMap.js/saveConversationField), so it occupies position 0 before any work-link
// claim is appended here. Duplicates (case-insensitive) are skipped rather than re-added. Since the
// column is NVarChar(200), not every name offered may fit - this stops adding once the joined list
// would overflow, rather than truncating a name mid-word. Returns how many were newly stored.
async function addAliases(userId, names) {
  const list = Array.isArray(names) ? names.map((n) => String(n ?? '').trim()).filter(Boolean) : parseAliasList(names);
  const bounded = [...new Set(list)].filter((n) => n.length <= MAX_ALIAS_LENGTH).slice(0, MAX_ALIASES_PER_TURN);
  if (bounded.length === 0) return 0;

  const account = await registrationRepository.findByAccountId(userId);
  const existing = splitAliasList(account?.AccountAlias);
  const existingLower = new Set(existing.map((n) => n.toLowerCase()));

  let merged = existing;
  let added = 0;
  for (const name of bounded) {
    if (existingLower.has(name.toLowerCase())) continue;
    const candidate = [...merged, name];
    if (candidate.join(', ').length > ALIAS_COLUMN_MAX_LENGTH) break; // no more room
    merged = candidate;
    existingLower.add(name.toLowerCase());
    added += 1;
  }
  if (added === 0) return 0;

  await registrationRepository.update(userId, { AccountAlias: merged.join(', ') });
  return added;
}

async function isEmailTakenByAnotherAccount(userId, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const owner = await registrationRepository.findByAccountEmail(normalized);
  return Boolean(owner) && String(owner.AccountId) !== String(userId);
}

// OCR dates come back as "DD/MM/YYYY" strings (per the Document Verification API's documented
// response shape, e.g. PAN's "dob": "01/01/1990") - JS's Date constructor assumes MM/DD/YYYY, so
// parse explicitly. Returns undefined (skip the write) rather than throwing on an unparseable value.
function parseOcrDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? ''));
  if (!match) return undefined;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// A failed OCR extraction never fails the upload - the document still saves,
// just flagged unverified (DocStatus = 2) so it can be reviewed manually.
// `addressSlot` is the original docType saveDocument() was called with, before any ocrDocType
// override - lets an address-proof upload's extracted address be routed to the right column
// (PERMANENT_ADDRESS_PROOF/CURRENT_ADDRESS_PROOF), independent of which OCR type actually ran.
// The passport module names its fields differently from every other document: `dateOfBirth` not
// `dob`, `sex` not `gender`, and `surname` + `givenName` instead of one `name`. Normalising once
// here keeps the persistence below document-agnostic - the alternative was a docType check on every
// one of those writes, and the DOB/gender ones would have silently done nothing until someone
// noticed. Passport-only keys (passportNumber, dateOfExpiry, nationality) are left as they are.
// Exported for ocrLabels.test.js - a pure function, and the passport field names are exactly
// the kind of thing that breaks silently.
export function normalizeExtracted(docType, extracted) {
  if (!extracted) return extracted;

  if (docType === DOC_TYPES.PAN) {
    // Confirmed live against the real document-OCR endpoint (POST /api/documents/pan with a real
    // card): { pan, name, fatherName, dob, gender, isValid, ... } - pan/name were already right; no
    // full_name_split field exists there (that shape belongs to a separate "PAN Comprehensive"
    // verification API, not this one - its response is nested inside this one's own
    // `verification` block). Split `name` itself instead; keep full_name_split as a fallback in
    // case a future response variant does send it.
    const providedSplit = Array.isArray(extracted.full_name_split) ? extracted.full_name_split.filter(Boolean) : [];
    const name = extracted.name ?? extracted.full_name;
    const tokens = providedSplit.length ? providedSplit : (name ? name.trim().split(/\s+/).filter(Boolean) : []);
    return {
      ...extracted,
      pan: extracted.pan ?? extracted.pan_number,
      name,
      // Both, when the response has both - not just whichever comes first. Most PAN cards only
      // ever print one, but this doesn't assume that.
      parentName: [extracted.fatherName, extracted.motherName].filter(Boolean).join(', ') || undefined,
      // First two tokens join into FirstName, whatever's left joins into LastName.
      firstName: tokens.length ? tokens.slice(0, 2).join(' ') : undefined,
      lastName: tokens.length > 2 ? tokens.slice(2).join(' ') : undefined,
    };
  }

  if (docType === DOC_TYPES.PASSPORT) {
    const fullName = [extracted.givenName, extracted.surname].filter(Boolean).join(' ').trim();
    return {
      ...extracted,
      name: extracted.name ?? (fullName || undefined),
      dob: extracted.dob ?? extracted.dateOfBirth,
      gender: extracted.gender ?? extracted.sex,
    };
  }

  if (docType !== DOC_TYPES.GST) return extracted;
  // Confirmed live against the real document-OCR endpoint (POST /api/documents/gst with a real
  // certificate): { legalName, gstin, address, pincode, isValid, ... } - address/pincode/gstin/
  // isValid already match the names the rest of this pipeline reads; only `legalName` needs
  // renaming onto the shared `name` field the AccountName write-once block and confirmation card use.
  return { ...extracted, name: extracted.legalName };
}

async function runOcrAndPersist(registrationId, docType, documentUrl, addressSlot) {
  try {
    // addressSlot is the ORIGINAL upload slot before OCR_TYPE_BY_DOC_TYPE's remap (docType is the
    // remapped, effective OCR type) - PAN vs COMPANY_PAN tells the pan endpoint which holder type
    // to expect. Shared across all 4 flow paths (the same PAN/COMPANY_PAN slots are reused by both
    // domestic and NRI branches), so this needs no path-specific branching.
    const account = await registrationRepository.findByAccountId(registrationId);
    const panHolderType = docType === DOC_TYPES.PAN
      ? (addressSlot === DOC_TYPES.COMPANY_PAN ? 'c' : addressSlot === DOC_TYPES.PAN ? 'p' : undefined)
      : undefined;
    // holderName is sent for the OCR service's own name verification (DRIVING_LICENCE/PASSPORT/
    // VOTER_ID/BANK only, confirmed with the OCR team - see httpOcrProvider.js). On the two company
    // paths (C/NC), AccountName already holds the COMPANY's own name, not a person's - it comes from
    // COMPANY_PAN's OCR (remapped to effective docType 'PAN' - see OCR_TYPE_BY_DOC_TYPE), whose own
    // `name` field is the company's registered name on that PAN card, written into AccountName by
    // the IDENTITY_OCR_DOC_TYPES block below. Sending it here lets the BANK OCR call verify the
    // uploaded passbook/cheque is actually in the company's name, same as the individual path
    // verifies its own AccountName against its bank document.
    const holderName = account?.AccountName?.trim() || undefined;
    const extracted = normalizeExtracted(docType, await ocrProvider.extract({ docType, documentUrl, panHolderType, holderName }));

    if (docType === DOC_TYPES.PAN && extracted.pan) {
      const panUpdate = { Detail2: extracted.pan };
      // Write-once, same guard AccountName uses below - a later PAN re-upload shouldn't clobber an
      // already-confirmed name split.
      if (extracted.firstName && !account?.FirstName?.trim()) panUpdate.FirstName = extracted.firstName.slice(0, 30);
      if (extracted.lastName && !account?.LastName?.trim()) panUpdate.LastName = extracted.lastName.slice(0, 45);
      if (extracted.parentName && !account?.FatherName?.trim()) panUpdate.FatherName = extracted.parentName.slice(0, 100);
      await registrationRepository.update(registrationId, panUpdate);
    }

    // The member's name, taken from an identity document. This is the only name in the system with
    // any evidence behind it - everything else is self-declared - so the work-link credit match
    // depends on it (see workMatch.service.js).
    //
    // Written ONLY when AccountName is still empty. That guard is what makes this safe: the field
    // was previously left unpersisted because OCR-formatted text could clobber a real name already
    // on the row. Restricted to identity documents too - an electricity bill's name is often a
    // landlord's or a parent's, which is evidence of nothing.
    if (IDENTITY_OCR_DOC_TYPES.includes(docType) && extracted.name && !account?.AccountName?.trim()) {
      const name = String(extracted.name).trim().slice(0, 100);
      const nameUpdate = { AccountName: name };
      // Same "write once" guard as AccountName above - the member's name is the first trustworthy
      // identity this account has, so it doubles as who created/last-touched the account record.
      if (!account?.CreatedBy?.trim()) nameUpdate.CreatedBy = name;
      if (!account?.ModifedBy?.trim()) nameUpdate.ModifedBy = name;
      await registrationRepository.update(registrationId, nameUpdate);
    }

    // GST number - Detail1. The company/NRI chat flow has no typed "what's your GST number"
    // question of its own (that text step, gated by GST_VERIFY_ENABLED, lives on a path this flow
    // never reaches), so this is the only source Detail1 ever gets filled from. Write-once, same
    // guard as AccountName/FirstName/LastName above: fires from either GST upload slot (the
    // required GST_CERTIFICATE doc, or the address-proof GST option), whichever arrives first wins.
    if (docType === DOC_TYPES.GST && extracted.gstin && !account?.Detail1?.trim()) {
      await registrationRepository.update(registrationId, { Detail1: extracted.gstin });
    }

    if (docType === DOC_TYPES.BANK) {
      const bankUpdate = {};
      for (const [ocrKey, dbKey] of Object.entries(BANK_FIELD_MAP)) {
        if (extracted[ocrKey] != null) bankUpdate[dbKey] = extracted[ocrKey];
      }
      if (Object.keys(bankUpdate).length > 0) {
        await registrationRepository.update(registrationId, bankUpdate);
      }
    }

    const addressColumn = ADDRESS_COLUMN_BY_SLOT[addressSlot];
    if (extracted.address && addressColumn) {
      const addressUpdate = { [addressColumn]: extracted.address };
      const pincode = extractPincode(extracted.address);
      if (pincode) addressUpdate[PINCODE_COLUMN_BY_ADDRESS_COLUMN[addressColumn]] = pincode;
      await registrationRepository.update(registrationId, addressUpdate);
      // Most members fill the permanent address via a document upload (this branch), not the
      // manual-typed chat question - BookId's resolution has to fire from here too, not just
      // saveConversationField's AccountAddress branch, or it silently never runs for them.
      // Best-effort, same as that call site: a BookId failure (e.g. dbo.GetStateBookId missing on a
      // deployed DB - confirmed live) is not a document-verification failure and must never be
      // reported to the member as one, nor block the address that was already saved above.
      if (addressColumn === 'AccountAddress') {
        try {
          await resolveAndPersistBookId(registrationId);
        } catch (err) {
          logger.warn({ registrationId, err }, 'Could not resolve BookId, continuing without it');
        }
      }
    }

    // Whichever doc type happens to extract these - PAN/Passport for dob, Aadhaar/Voter ID for
    // gender - opportunistically persisted the same way address is above.
    const dob = parseOcrDate(extracted.dob);
    if (dob) {
      await registrationRepository.update(registrationId, { DOB: dob });
    }
    if (extracted.gender) {
      await registrationRepository.update(registrationId, { Gender: extracted.gender });
    }
    // Only the passport carries this. The NRI path also asks for nationality in the chat and writes
    // the same column - last write wins, which is what conversationFieldMap.js already says.
    if (extracted.nationality) {
      await registrationRepository.update(registrationId, {
        Nationality: String(extracted.nationality).trim().slice(0, 100),
      });
    }
    // Aadhaar's extracted number/name/dob/gender/address are intentionally not
    // persisted to AppAccounts - only used here to compute `verified`.
    return { verified: Boolean(extracted.isValid), extracted };
  } catch (err) {
    logger.warn(
      { registrationId, docType, stage: err.details?.stage, details: err.details, err },
      'OCR extraction failed, document saved unverified',
    );
    // Surfaces the OCR service's own message (e.g. a wrong-document-type or low-confidence reason)
    // up to the user-facing failure text in registrationEngine.js, instead of only a generic one.
    return { verified: false, extracted: null, failureReason: err.message || null };
  }
}

async function complete(userId, registrationId) {
  assertOwnRegistration(userId, registrationId);

  const account = await registrationRepository.findByAccountId(registrationId);
  if (!account) throw notFoundError('Registration not found');

  // Only AccountEmail is actually collected by the live Typebot chat flow (via
  // conversationFieldMap.js's unconditional "Provide your email id" question) -
  // the flow has no blocks and no HTTP Request callbacks for first/last name,
  // DOB, gender, or address, so requiring them here would make chat-driven
  // completion permanently impossible.
  const missing = [];
  if (!account.AccountEmail) missing.push('basic-details');

  const docs = await registrationRepository.findDocumentsByAccountId(registrationId);
  const uploadedTypes = new Set(docs.map((doc) => doc.DocumentName));
  for (const group of REQUIRED_DOC_GROUPS) {
    if (!group.types.some((docType) => uploadedTypes.has(docType))) missing.push(group.label);
  }

  // The Typebot flow's own "Pay" block is just a normal choice input - answering it in chat (even
  // by hand, bypassing the frontend entirely) advances the conversation to Typebot's own scripted
  // "Thank you" closing message with no real PayU charge involved. Importing paymentRepository
  // directly (not paymentService) here is deliberate: payment.service.js already imports
  // registrationService to call complete() after a real PayU success, so importing the service back
  // would be circular - the repository has no such dependency.
  if (!(await paymentRepository.hasSuccessfulPayment(registrationId))) missing.push('payment');

  if (missing.length > 0) {
    throw badRequestError(`Registration incomplete: missing ${missing.join(', ')}`, {
      errorCode: 'REGISTRATION_INCOMPLETE',
      details: { missing },
    });
  }

  // Territory defaults to WORLD when the user skipped the flow's territory question (or never
  // reached it) - an actual INDIA/WORLD answer is already persisted by saveConversationField() and
  // wins. Done here rather than on the skip itself: the territory blocks have no Typebot skip
  // option, and registrationEngine.handle() only persists a truthy answer, so there's no skip
  // event to hook. Idempotent - only fires while the column is still empty.
  if (!account.TeritoryAppFor?.trim()) {
    await registrationRepository.update(registrationId, { TeritoryAppFor: 'WORLD' });
  }

  const updated = account.ApplicationStatus === REGISTERED ? account : await registrationRepository.markCompleted(registrationId);
  return toPublic(updated);
}

function toDocumentPublic(doc, ocrResult) {
  return {
    registrationId: String(doc.AccountId),
    // DocumentName holds the type, DocumentCaption the URL (see registration.repository.js) - the
    // response keys below intentionally keep their original, self-describing names.
    documentType: doc.DocumentName,
    documentUrl: doc.DocumentCaption,
    status: doc.DocStatus,
    updatedAt: doc.ModifedDate,
    ...(ocrResult
      ? {
          verified: ocrResult.verified,
          extracted: ocrResult.extracted,
          ...(ocrResult.failureReason ? { failureReason: ocrResult.failureReason } : {}),
        }
      : {}),
  };
}

function toPublic(account) {
  const completed = account.ApplicationStatus === REGISTERED;
  return {
    userId: String(account.AccountId),
    currentStep: completed ? env.REGISTRATION_TOTAL_STEPS : 0,
    completed,
    totalSteps: env.REGISTRATION_TOTAL_STEPS,
    updatedAt: account.ModifedDate,
  };
}

export const registrationService = {
  getIdentityNames,
  getStatus,
  saveDocument,
  saveConversationField,
  copyPermanentAddressToCurrent,
  isEmailTakenByAnotherAccount,
  addAliases,
  parseAliasList,
  splitAliasList,
  complete,
  DOC_TYPES,
};
