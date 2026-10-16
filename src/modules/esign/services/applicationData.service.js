// ==================================================================
// Everything printed on a member's IPRS application form, read from the DATABASE.
//
// The form copies the layout IPRS's own system prints (individual and company variants): Part 1
// personal details, Part 3 addresses, Part 4 other info, Part 5 bank, the declaration the member
// signs, Part 7 work notification and Part 8 documents. This service only gathers and formats the
// values; templates/applicationForm.js lays them out.
//
// Values the chat never asks for (alternate phone/email, WhatsApp, a company's establishment
// date, a separate city/state) are left blank or "NA", the way IPRS's own forms show them -
// nothing is guessed.
// ==================================================================
import { notFoundError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';
import { registrationRepository } from '../../registration/repositories/registration.repository.js';
import { registrationReviewService } from '../../registration/services/registrationReview.service.js';
import { registrationService } from '../../registration/services/registration.service.js';
import { describeEntityType, listRoleLabels, REG_TYPES } from '../../registration/services/memberRoleCodes.js';
import { workRepository } from '../../work/repositories/work.repository.js';
import { esignRepository } from '../repositories/esign.repository.js';

const NA = 'NA';
const PHOTO_TIMEOUT_MS = 10_000;
const PHOTO_DOCUMENT_TYPES = ['PROFILE_PHOTO', 'COMPANY_PHOTO'];

// App_Accounts_Doc.DocumentName of the signed form itself (esign.service.js writes it) - never
// listed on the form, or a second signing would print the first one as a supporting document.
export const SIGNED_APPLICATION_DOCUMENT = 'SIGNED_APPLICATION';

// TeritoryAppFor holds IPRS's numeric codes - registration.service.js writes exactly these two.
const TERRITORY_BY_CODE = { 2136: 'WORLD', '0356': 'INDIA' };

// The role wording IPRS prints, by MemberRoleType_LookUp id (see memberRoleCodes.js).
const ROLE_WORDING = {
  Composer: 'Author (Music Composer / Musical Works)',
  Lyricist: 'Author (Lyricist / Lyrical Works)',
  Publisher: 'Publisher',
};

const isCompanyRegType = (regType) => regType === REG_TYPES.PUBLISHER || regType === REG_TYPES.NRI_PUBLISHER;
const isIndianRegType = (regType) => regType === REG_TYPES.INDIVIDUAL || regType === REG_TYPES.PUBLISHER;

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

const upper = (value) => text(value).toUpperCase();
const orNA = (value) => text(value) || NA;

// Day/month in India's own time, whatever zone the server runs in.
function dateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

// 01-10-2026
export function formatDate(value) {
  const p = value ? dateParts(value) : null;
  return p ? `${p.day}-${p.month}-${p.year}` : '';
}

// 01-10-2026 05:21:00 PM
export function formatDateTime(value) {
  const p = value ? dateParts(value) : null;
  return p ? `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second} ${p.dayPeriod.toUpperCase()}` : '';
}

// 02-Oct-2001 - DOB is a calendar date stored at UTC midnight, so it is read in UTC.
export function formatBirthDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .replace(/ /g, '-');
}

// 919892807545 -> +91-9892807545
export function formatMobile(value) {
  const digits = text(value).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return `+91-${digits.slice(2)}`;
  return text(value);
}

// "AUTHOR (MUSIC COMPOSER / MUSICAL WORKS), AUTHOR (LYRICIST / LYRICAL WORKS)" for the Role Type
// line, and the same roles in sentence case for the declaration ("... as a Author (...)").
export function describeRoles(account) {
  const labels = listRoleLabels(account.RollTypeIds);
  const ordered = ['Composer', 'Lyricist', 'Publisher'].filter((label) => labels.includes(label));
  const company = isCompanyRegType(text(account.AccountRegType));
  if (!ordered.length && company) ordered.push('Publisher');
  const wording = ordered.map((label) => ROLE_WORDING[label]);
  const declaration = wording.join(', ');

  let roleType = wording.map((w) => w.toUpperCase()).join(', ');
  const entity = describeEntityType(account.EntityType);
  if (company && entity) roleType = `PUBLISHER (${entity} )`;
  return { roleType, declaration, isPublisher: ordered.includes('Publisher') };
}

function describeTerritory(code) {
  return TERRITORY_BY_CODE[text(code)] ?? orNA(code);
}

// AccountAlias may hold several names (see registration.service.js's addAliases).
function describeAlias(value) {
  return registrationService.splitAliasList(value).join(', ');
}

// The photo is embedded as a data URI so the PDF never depends on the network while rendering.
async function loadPhoto(documents, fetchImpl = fetch) {
  const photo = documents.find((doc) => PHOTO_DOCUMENT_TYPES.includes(doc.DocumentName) && text(doc.DocumentCaption));
  if (!photo) return null;
  try {
    const response = await fetchImpl(photo.DocumentCaption, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not load the member photo for the application form');
    return null;
  }
}

function describeAddress(line, pincode, regType) {
  return {
    line: upper(line),
    city: '',
    pincode: text(pincode),
    state: '',
    country: line && isIndianRegType(regType) ? 'INDIA' : '',
  };
}

function describeWork(work) {
  return {
    songName: upper(work.SongName),
    album: upper(work.Film_AlbumName),
    languages: upper(work.LanguageNames),
    category: upper(work.WorkCategory),
    singers: upper(work.Artist_Singers),
    composer: upper(work.Author_Composer),
    publisher: upper(work.Publisher),
    lyricist: upper(work.Author_Lyricist),
    digitalLink: text(work.DigitalLink),
    fileLink: text(work.DocLink),
    releaseYear: text(work.ReleaseYear),
  };
}

/**
 * @param {string|number|bigint} userId
 * @param {{ signedAt?: Date, ip?: string, guid?: string, fetchImpl?: typeof fetch }} [options]
 *   signedAt/ip/guid describe this signing; they default to now and what is already on the account.
 */
async function buildApplicationData(userId, { signedAt = new Date(), ip, guid, fetchImpl } = {}) {
  const account = await registrationRepository.findByAccountId(userId);
  if (!account) throw notFoundError('Registration not found');

  const [allDocuments, works] = await Promise.all([
    registrationRepository.findDocumentsByAccountId(userId),
    workRepository.findByAccountId(userId),
  ]);
  const documents = allDocuments.filter((doc) => doc.DocumentName !== SIGNED_APPLICATION_DOCUMENT);
  const [lookupNames, photo] = await Promise.all([
    esignRepository.findDocumentLookupNames(documents.map((doc) => doc.DocumentLookupId)),
    loadPhoto(documents, fetchImpl),
  ]);

  const regType = text(account.AccountRegType);
  const company = isCompanyRegType(regType);
  const roles = describeRoles(account);
  const personName = [text(account.FirstName), text(account.LastName)].filter(Boolean).join(' ');
  const accountName = upper(account.AccountName);

  return {
    variant: company ? 'company' : 'individual',
    regType,
    applicationNo: String(account.AccountId),
    applicationDate: formatDate(account.CreateDate),
    roleType: roles.roleType,
    declarationRoles: roles.declaration,
    isPublisher: roles.isPublisher,
    photo,

    companyName: company ? accountName : '',
    establishmentDate: '',
    // A company's own name lives in AccountName; the person behind it is only known if a PAN
    // gave a first/last name.
    fullName: company ? upper(personName) : accountName,
    alias: upper(describeAlias(account.AccountAlias)),
    pan: upper(account.Detail2),
    gst: orNA(upper(account.Detail1)),
    nationality: upper(account.Nationality),
    parentName: upper(account.FatherName),
    placeOfBirth: upper(account.PlaceOfBirth),
    dob: formatBirthDate(account.DOB),
    mobile: formatMobile(account.AccountMobile),
    altPhone: formatMobile(account.AccountMobile_Alt),
    email: upper(account.AccountEmail),
    altEmail: upper(account.Alt_EmailId),
    whatsapp: '',
    gender: upper(account.Gender),
    preferredLanguage: upper(account.PreferredLanguage),

    addresses: {
      firstLabel: company ? 'Registered Address' : 'Permanent Address',
      secondLabel: company ? 'Communication Address' : 'Present Address',
      first: describeAddress(account.AccountAddress, account.Pincode, regType),
      second: describeAddress(account.AccountAddress_PR, account.Pincode_PR, regType),
    },

    other: {
      territory: describeTerritory(account.TeritoryAppFor),
      memberOfOverseasSociety: text(account.OverseasSocietyName) ? 'YES' : 'NO',
      overseasSocietyName: orNA(upper(account.OverseasSocietyName)),
      internalIdentificationName: orNA(upper(account.InternalIdentificationName)),
      ipiNumber: orNA(account.IPINumber),
      indiaAssociation: orNA(upper(account.AssociationName_India)),
    },

    bank: {
      name: upper(account.BankName),
      accountNo: text(account.BankAcNo),
      branch: upper(account.BankBranchName),
      ifsc: upper(account.BankIFSCCode),
      micr: text(account.MicrCode),
      currency: isIndianRegType(regType) ? 'INDIAN RUPEES' : upper(account.CurrencyName),
      accountName: upper(account.BankAccountName) || accountName,
    },

    signing: {
      date: formatDateTime(signedAt),
      place: '',
      macid: orNA(account.Macid),
      guid: orNA(guid ?? account.GUID),
      ip: orNA(ip ?? account.PublicIP),
      submittedDate: formatDateTime(signedAt),
      signerName: accountName,
    },

    works: works.map(describeWork),
    documents: documents.map((doc) => ({
      name:
        text(lookupNames.get(String(doc.DocumentLookupId))) ||
        registrationReviewService.DOCUMENT_LABELS[doc.DocumentName] ||
        text(doc.DocumentName),
      url: text(doc.DocumentCaption),
    })),

    footerName: accountName,
  };
}

export const applicationDataService = { buildApplicationData };
