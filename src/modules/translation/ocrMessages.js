// ==================================================================
// Member-facing wording for the OCR service's refusals, in the member's
// language.
//
// The OCR service answers in English only. Its sentences are assembled at
// runtime from a code plus a document name - "This looks like a cancelled
// cheque, not a PAN card." - so there are 27 x 28 of that one sentence alone,
// and roughly 800 in total. Putting the finished sentences in the dictionary
// would be ~3,000 entries across four languages, every one of them dead the
// next time the OCR service rewords anything.
//
// So the TEMPLATE is translated, not the sentence, and the slots are filled
// afterwards from their own small tables. ~60 phrases cover all ~800 sentences.
// Templates are matched on the service's `code`, never on its English text -
// the same rule the payment buttons follow (see paymentBlockIds.js).
//
// The English template is the dictionary key, so every string here is editable
// from the admin panel like any other phrase, and picks up the dictionary's
// hot-reload.
//
// Two deliberate choices:
//   - {article} has no equivalent in hi/mr/gu/bn. A translated template simply
//     leaves the slot out and it disappears. This is the thing that cannot be
//     done by translating finished English sentences.
//   - Codes a member cannot act on (a malformed request, a blocked URL - bugs
//     in our own integration) collapse to one generic apology rather than a
//     literal translation. The real detail stays in `details` and the logs,
//     where the person who can fix it will look.
// ==================================================================
import { lookup } from './dictionary.js';

// Sentences shown when the member can do something about it.
const TEMPLATES = {
  DOCUMENT_NOT_REGISTERED:
    'This {friendly} is not valid - the number is not registered with the issuing authority.',
  DOCUMENT_DETAILS_MISMATCH:
    "This {friendly} is not valid - the {fields} does not match the issuing authority's record.",
  VERIFICATION_UNAVAILABLE:
    '{friendly} could not be verified right now. This is not a finding against the document - please try again.',
  NAME_MISMATCH:
    "The name does not match the name on this document. Check the spelling, or upload a document in this member's name.",
  WRONG_DOCUMENT_TYPE:
    'This looks like {article} {detected}, not {article} {expected}. Please upload your {expected}.',
  WRONG_DOCUMENT_TYPE_UNRECOGNISED:
    'This does not look like {article} {expected}. Please upload a clear photo of your {expected}.',
  WRONG_HOLDER_TYPE:
    'This is {article} {detected} {expected}, not {article} {wanted} one. Please upload {article} {wanted} {expected}.',
  IMAGE_QUALITY_TOO_LOW:
    'The image is too blurred to read. Retake the photo in better light, holding the camera steady and filling the frame with the document.',
  DOCUMENT_NUMBER_NOT_FOUND:
    'We could not read the details from this {friendly}. Please upload a clear photo of the whole document.',
  DOCUMENT_READ_FAILED:
    'This document could not be opened. Please upload it again, or try a clear photo instead of a PDF.',
  UNSUPPORTED_FILE_TYPE:
    'That file type is not supported. Please upload a JPEG, PNG or PDF.',
  LIMIT_FILE_SIZE:
    'This file is too large. Please upload a document under {limit}MB.',
  DOCUMENT_FETCH_FAILED:
    'We could not download the document you uploaded. Please try uploading it again.',
  NUMBER_NOT_VERIFIED:
    'This {label} could not be verified with the issuing authority. Please check the number and try again.',
  NUMBER_MALFORMED: 'That is not a valid {label}. Please check the number and try again.',
  VERIFICATION_SERVICE_UNAVAILABLE:
    'We could not reach the verification service right now. Please try again in a few minutes.',
};

// Anything a member cannot act on. One apology, detail kept in the logs.
const GENERIC = 'We could not process this document. Please try again.';

const GENERIC_CODES = new Set([
  'INVALID_BODY',
  'DOCUMENT_URL_REQUIRED',
  'HOLDER_TYPE_INVALID',
  'INVALID_DOCUMENT_URL',
  'BLOCKED_DOCUMENT_URL',
  'DOCUMENT_TYPE_INVALID',
  'VERIFICATION_TYPE_INVALID',
  'UNAUTHORISED',
  'OCR_UNSUPPORTED_DOC_TYPE',
]);

// The readable document name. The OCR service sends the uppercase type in
// `expectedDocument` / `detectedDocument`; these are the words a member reads.
const DOCUMENT_NAMES = {
  PAN: 'PAN card',
  AADHAAR: 'Aadhaar card',
  DRIVING_LICENCE: 'driving licence',
  VOTER_ID: 'voter ID card',
  PASSPORT: 'passport',
  BANK: 'bank document',
  BANK_CHEQUE: 'cancelled cheque',
  BANK_PASSBOOK: 'bank passbook',
  BANK_STATEMENT: 'bank statement',
  BANK_LETTER: 'letter from a bank',
  ELECTRICITY: 'electricity bill',
  TELEPHONE_BILL: 'telephone bill',
  MOBILE_BILL: 'mobile bill',
  GST: 'GST registration certificate',
  MSME: 'MSME or Udyam certificate',
  INCORPORATION: 'certificate of incorporation',
  MOA: 'memorandum of association',
  TRC: 'tax residency certificate',
  TIN: 'tax identification certificate',
  FORM_10F: 'Form 10F',
  SOCIETY_NOC: 'society NOC letter',
  BOARD_RESOLUTION: 'board resolution',
  LETTER_FROM_OWNER: 'letter from the owner',
  LEAVE_LICENSE: 'leave and licence agreement',
  ADDRESS_PROOF_INDIVIDUAL: 'residential address proof',
  ADDRESS_PROOF_COMPANY: 'company address proof',
  NO_PE_DECLARATION: 'no-permanent-establishment declaration',
  PUBLISHER_DECLARATION: 'publisher self-declaration',
};

// The cross-check fields named in DOCUMENT_DETAILS_MISMATCH. The service sends
// bare keys; "dob" is not something to show a member untranslated.
const FIELD_NAMES = {
  number: 'number',
  name: 'name',
  dob: 'date of birth',
  gender: 'gender',
  age: 'age',
  relation: "father's or husband's name",
};

// PAN holder types, for WRONG_HOLDER_TYPE.
const HOLDER_TYPES = {
  P: 'Individual',
  C: 'Company',
  F: 'Firm or LLP',
  A: 'Association of Persons',
  B: 'Body of Individuals',
  T: 'Trust',
  H: 'Hindu Undivided Family',
  L: 'Local Authority',
  J: 'Artificial Juridical Person',
  G: 'Government',
  p: 'Individual',
  c: 'Company',
};

// The service documents these as expectedHolderType / detectedHolderType but
// not whether it sends the code ("C") or the word ("Company"), and a holder
// type it does not recognise would silently drop the whole sentence back to
// English. Both forms resolve, and the word is matched case-insensitively.
const HOLDER_TYPE_WORDS = new Map(
  Object.entries(HOLDER_TYPES).map(([, word]) => [word.toLowerCase(), word]),
);

function holderType(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return HOLDER_TYPES[raw] ?? HOLDER_TYPE_WORDS.get(raw.toLowerCase()) ?? null;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

function article(word) {
  const first = String(word ?? '').trim().toLowerCase()[0];
  return VOWELS.has(first) ? 'an' : 'a';
}

/** English phrase -> the member's language, or the English back if unlisted. */
function say(phrase, language) {
  if (!phrase) return phrase;
  try {
    return lookup(phrase, language) ?? phrase;
  } catch {
    return phrase;
  }
}

function documentName(type, language) {
  const english = DOCUMENT_NAMES[String(type ?? '').toUpperCase()];
  return english ? say(english, language) : null;
}

function fieldList(fields, language) {
  const list = Array.isArray(fields) ? fields : String(fields ?? '').split(',');
  const named = list
    .map((f) => String(f ?? '').trim())
    .filter(Boolean)
    .map((f) => say(FIELD_NAMES[f] ?? f, language));
  return named.length ? named.join(', ') : null;
}

/**
 * Which template a code resolves to. WRONG_DOCUMENT_TYPE has two forms: the
 * service nulls detectedDocument when nothing matched clearly, and the "looks
 * like X" wording would otherwise read "looks like a null".
 */
function templateKeyFor(code, ocr) {
  if (code !== 'WRONG_DOCUMENT_TYPE') return code;
  const detected = String(ocr?.detectedDocument ?? '').toUpperCase();
  return detected && detected !== 'UNRECOGNISED' && DOCUMENT_NAMES[detected]
    ? 'WRONG_DOCUMENT_TYPE'
    : 'WRONG_DOCUMENT_TYPE_UNRECOGNISED';
}

/**
 * Build the member-facing sentence for one OCR refusal.
 *
 * `ocr` is what the service sent: { code, expectedDocument, detectedDocument,
 * fields, detectedHolderType, expectedHolderType, label, limit }.
 * Returns null when there is nothing better to say than the English the
 * service sent - the caller then keeps its existing behaviour.
 */
export function composeOcrMessage(ocr, language) {
  const code = String(ocr?.code ?? '').trim();
  if (!code || !language) return null;

  if (GENERIC_CODES.has(code)) return say(GENERIC, language);

  const key = templateKeyFor(code, ocr);
  const englishTemplate = TEMPLATES[key];
  if (!englishTemplate) return null;

  const template = say(englishTemplate, language);

  const expectedType = ocr?.expectedDocument ?? ocr?.documentType;
  const expected = documentName(expectedType, language);
  const detected = documentName(ocr?.detectedDocument, language);
  const fields = fieldList(ocr?.fields, language);
  const wantedEnglish = holderType(ocr?.expectedHolderType);
  const detectedHolderEnglish = holderType(ocr?.detectedHolderType);

  // A template that needs a name we could not resolve would render "This
  // {friendly} is not valid" with a hole in it. Better to let the caller fall
  // back to the service's own English than to show a broken sentence.
  const needs = (slot) => template.includes(`{${slot}}`);
  const isHolderType = key === 'WRONG_HOLDER_TYPE';

  // The holder-type refusal names two holder types, not two documents, so the
  // document-name guards below do not apply to it - the service sends no
  // expectedDocument for it, and requiring one rejected every such message.
  if (isHolderType) {
    if (!wantedEnglish || !detectedHolderEnglish) return null;
  } else {
    if (needs('friendly') && !expected) return null;
    if (needs('expected') && !expected) return null;
    if (needs('detected') && !detected) return null;
    if (needs('fields') && !fields) return null;
  }

  const values = {
    friendly: expected,
    // 'PAN', not 'PAN card' - the OCR service's own holder-type wording never says "card", and
    // the dictionary's "PAN" entry is deliberately left untranslated in every language.
    expected: isHolderType ? say('PAN', language) : expected,
    detected: isHolderType ? say(detectedHolderEnglish, language) : detected,
    fields,
    wanted: say(wantedEnglish, language),
    label: say(ocr?.label ?? 'number', language),
    limit: ocr?.limit ?? '10',
  };

  // {article} is filled from the ENGLISH word, because that is the only
  // language it exists in. Translated templates have no article slot, so this
  // resolves to nothing for them.
  const englishFor = {
    friendly: DOCUMENT_NAMES[String(expectedType ?? '').toUpperCase()],
    expected: DOCUMENT_NAMES[String(expectedType ?? '').toUpperCase()],
    detected: DOCUMENT_NAMES[String(ocr?.detectedDocument ?? '').toUpperCase()],
  };

  let out = template;
  // Articles first, each taking its case from the word that follows it.
  out = out.replace(/\{article\}\s+\{(\w+)\}/g, (_m, slot) => {
    const english = englishFor[slot] ?? values[slot];
    return `${article(english)} ${values[slot] ?? ''}`;
  });
  out = out.replace(/\{article\}/g, (_m) => article(englishFor.expected ?? ''));
  out = out.replace(/\{(\w+)\}/g, (_m, slot) =>
    values[slot] === null || values[slot] === undefined ? '' : String(values[slot]),
  );

  return out.replace(/\s{2,}/g, ' ').trim();
}

export const ocrMessageCatalogue = {
  TEMPLATES,
  GENERIC,
  GENERIC_CODES,
  DOCUMENT_NAMES,
  FIELD_NAMES,
  HOLDER_TYPES,
};
