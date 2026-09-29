// ==================================================================
// Everything on file for a member, shaped for the pre-payment review.
//
// Why this exists: a good part of what's stored was never typed by the
// member. PAN number, date of birth, bank name, account number, IFSC and
// branch all come from OCR reading their documents - and OCR gets things
// wrong (the live account's BankBranchName currently holds a passbook
// form label). A wrong account number sends royalties to the wrong
// place, so the last moment to catch it is before payment.
//
// Read from the DATABASE, not from Typebot's variables. If a value
// failed to persist, the review shows it missing - which is exactly what
// the member needs to know at this point.
// ==================================================================
import { notFoundError } from '../../../shared/errors.js';
import { registrationRepository } from '../repositories/registration.repository.js';
import { workRepository } from '../../work/repositories/work.repository.js';
import { describeEntityType, describeRegType, describeRollTypeIds } from './memberRoleCodes.js';
import { registrationService } from './registration.service.js';

// Column -> what the member should see it called. Order within each section is the order shown.
//
// Detail1/Detail2 appear here under their real meaning (GST / PAN) - they're generic columns
// IPRS's schema already has, and this app stores those two values there rather than adding
// columns of its own. The other Detail* columns stay out: Detail10 is an internal source tag,
// and the rest hold nothing this app writes.
const SECTIONS = [
  {
    title: 'Your details',
    fields: [
      ['AccountName', 'Name'],
      ['AccountAlias', 'Stage name'],
      ['DOB', 'Date of birth'],
      ['PlaceOfBirth', 'Place of birth'],
      ['Nationality', 'Nationality'],
      ['DualNationality', 'Dual nationality'],
      ['LanguageName', 'Mother tongue'],
      ['AccountEmail', 'Email'],
      ['AccountMobile', 'Mobile'],
    ],
  },
  {
    title: 'Membership',
    fields: [
      ['AccountRegType', 'Applying as'],
      ['RollTypeIds', 'Role'],
      ['EntityType', 'Entity type'],
      ['TeritoryAppFor', 'Territory'],
      ['Detail1', 'GST number'],
      ['TRCNo', 'TRC number'],
      ['AssociationName_India', 'Member of another society'],
      ['KindAttention1', 'Designation'],
    ],
  },
  {
    title: 'Address',
    fields: [
      ['AccountAddress', 'Permanent / registered'],
      ['AccountAddress_PR', 'Current / communication'],
    ],
  },
  { title: 'Identity', fields: [['Detail2', 'PAN']] },
  {
    // Shown in full, on purpose. These are the OCR-derived fields - masking the account number
    // would hide the single most expensive thing to get wrong.
    title: 'Bank',
    fields: [
      ['BankName', 'Bank'],
      ['BankAcNo', 'Account number'],
      ['BankIFSCCode', 'IFSC'],
      ['BankBranchName', 'Branch'],
      ['MicrCode', 'MICR'],
    ],
  },
];

// Stored document type -> what the member called it when they uploaded it.
const DOCUMENT_LABELS = {
  PAN: 'PAN card',
  COMPANY_PAN: 'Company PAN card',
  AADHAAR: 'Aadhaar',
  BANK: 'Bank passbook / cheque',
  NOC: 'NOC',
  COMPANY_NOC: 'Company NOC',
  COMPANY_DOC: 'Company document',
  PROFILE_PHOTO: 'Photo',
  COMPANY_PHOTO: 'Company photo',
  PERMANENT_ADDRESS_PROOF: 'Permanent address proof',
  CURRENT_ADDRESS_PROOF: 'Current address proof',
  REGISTERED_ADDRESS_PROOF: 'Registered address proof',
  COMM_ADDRESS_PROOF: 'Communication address proof',
  COMM_ADDRESS_PROOF_2: 'Communication address proof (2)',
  PASSPORT: 'Passport',
  TRC: 'Tax Residency Certificate',
  COMPANY_TRC: 'Company Tax Residency Certificate',
  SS_NUMBER: 'Social security number',
  TIN: 'TIN certificate',
  FORM_41: 'Form 41',
  SELF_DECLARATION: 'Self-declaration form',
  PEC: 'PEC',
  ENTITY_INCORPORATION: 'Certificate of incorporation',
  LETTER: 'Letter',
  GST_CERTIFICATE: 'GST certificate',
  MOA_AOA: 'MOA / AOA',
  BOARD_RESOLUTION: 'Board resolution',
  PARTNERSHIP_DEED: 'Partnership deed',
  AUTHORITY_LETTER: 'Authority letter',
  TUM: 'Trade licence / Udyog Aadhaar / MSME certificate',
};

function formatValue(column, value) {
  if (value === null || value === undefined) return null;

  if (column === 'DOB') {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    // Day-month-year, the way an Indian member reads a date back.
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // DualNationality is an Int column holding a Yes/No answer (see saveConversationField).
  if (column === 'DualNationality') return value === 1 ? 'Yes' : 'No';

  // Both of these hold IPRS's own codes, not the member's words - "I" and "2,1" mean nothing to
  // the person checking their own details, so show what they actually picked.
  if (column === 'AccountRegType') return describeRegType(value);
  if (column === 'RollTypeIds') return describeRollTypeIds(value);
  if (column === 'EntityType') return describeEntityType(value);

  // AccountAlias may hold several comma-separated names (see registration.service.js's addAliases -
  // position 0 is the flow's own stage-name answer, later positions are names claimed later via
  // work-link matching). "Stage name" lists every one of them, not just the first.
  if (column === 'AccountAlias') {
    const aliases = registrationService.splitAliasList(value);
    return aliases.length > 0 ? aliases.join(', ') : null;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function labelDocument(documentName) {
  return DOCUMENT_LABELS[documentName] ?? documentName;
}

// -> [{ title, lines: [{ label, value }] }] with empty fields and empty sections dropped, so a
// member who skipped the GST question never sees a blank GST line.
async function buildReview(userId) {
  const account = await registrationRepository.findByAccountId(userId);
  if (!account) throw notFoundError('Registration not found');

  const [documents, works] = await Promise.all([
    registrationRepository.findDocumentsByAccountId(userId),
    workRepository.findByAccountId(userId),
  ]);
  const sections = SECTIONS.map(({ title, fields }) => ({
    title,
    lines: fields
      .map(([column, label]) => ({ label, value: formatValue(column, account[column]) }))
      .filter((line) => line.value !== null),
  })).filter((section) => section.lines.length > 0);

  if (documents.length > 0) {
    sections.push({
      title: `Documents you uploaded (${documents.length})`,
      // No label - these render as a plain bullet list (see describeReview).
      lines: documents.map((doc) => ({ label: null, value: labelDocument(doc.DocumentName) })),
    });
  }

  if (works.length > 0) {
    sections.push({
      title: `Your songs (${works.length})`,
      lines: works.map((work) => ({
        label: null,
        // A missing SongName (workLinkResolver.service.js should now always fill it for a resolvable
        // YouTube/Spotify link, but a fetch failure or an older row can still leave it null) falls
        // back to the link itself rather than silently reading as a bare list of names.
        value: [work.SongName ?? work.DigitalLink, work.Artist_Singers].filter(Boolean).join(' - '),
      })),
    });
  }

  return sections;
}

// [{ title, lines }] -> plain text, one section per paragraph. Shared by the payment review
// (paymentGate.js's describeReview) and the resume summary (registrationEngine.js) - both just want
// "here is what's on file", worded differently around the same rendered body.
export function renderSections(sections) {
  return sections
    .map(({ title, lines }) => {
      const rendered = lines
        .map(({ label, value }) => (label ? `  ${label}: ${value}` : `  - ${value}`))
        .join('\n');
      return `${title}\n${rendered}`;
    })
    .join('\n\n');
}

export const registrationReviewService = { buildReview, renderSections, DOCUMENT_LABELS };
