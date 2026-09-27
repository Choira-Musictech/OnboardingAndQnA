// ==================================================================
// Every document type that gets OCR'd must have confirmation labels
// (node:test). No DB, no network.
//
// WHY: the OCR-confirmation card is built from OCR_FIELD_LABELS keyed
// by document type, but a document is not always OCR'd under the type
// it is stored as. An address proof is stored as
// PERMANENT_ADDRESS_PROOF and read as a DRIVING_LICENCE; a COMPANY_PAN
// is stored as COMPANY_PAN and read as a PAN.
//
// When the lookup misses, nothing throws - `?? {}` yields no lines and
// the member is shown "We extracted the following COMPANY_PAN details:"
// followed by a blank, then "Is this correct?". That is exactly what
// happened to COMPANY_PAN: OCR had succeeded, the card just had nothing
// to print. A silent empty card is worse than an error, so this asserts
// the mapping instead of trusting it.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OCR_FIELD_LABELS } from '../src/modules/conversation/engines/registrationEngine.js';
import { OCR_DOC_TYPES, OCR_TYPE_BY_DOC_TYPE, normalizeExtracted } from '../src/modules/registration/services/registration.service.js';

// The same resolution the engine does when labelling the card.
const effectiveType = (docType) => OCR_TYPE_BY_DOC_TYPE[docType] ?? docType;

test('every OCR-capable doc type resolves to a non-empty label set', () => {
  // Types read directly, plus types stored under one name and read as another.
  const reachable = new Set([...OCR_DOC_TYPES, ...Object.keys(OCR_TYPE_BY_DOC_TYPE)]);

  for (const docType of reachable) {
    const labels = OCR_FIELD_LABELS[effectiveType(docType)];
    assert.ok(
      labels && Object.keys(labels).length > 0,
      `${docType} (read as ${effectiveType(docType)}) has no confirmation labels - the card would be blank`,
    );
  }
});

test('COMPANY_PAN is labelled as a PAN', () => {
  // The regression this file was written for.
  assert.equal(effectiveType('COMPANY_PAN'), 'PAN');
  const labels = OCR_FIELD_LABELS[effectiveType('COMPANY_PAN')];
  assert.deepEqual(Object.values(labels), ['Name', 'PAN Number', 'Date of Birth', 'Holder Type']);
});

test('a doc type that is never OCR\'d needs no labels', () => {
  // NOC/PROFILE_PHOTO and friends fall through before the card is ever built.
  assert.equal(OCR_DOC_TYPES.includes('NOC'), false);
  assert.equal(OCR_TYPE_BY_DOC_TYPE.NOC, undefined);
});

// --- passport field normalisation ------------------------------------------

test('passport field names are mapped onto the shared ones', () => {
  // The passport module is the only one that returns surname/givenName, dateOfBirth and sex.
  // Without this mapping the DOB, Gender and AccountName writes in runOcrAndPersist silently do
  // nothing for a passport - the fields are simply absent under the names those writes look for.
  const raw = {
    documentType: 'PASSPORT',
    passportNumber: 'Z1234567',
    surname: 'DANISH',
    givenName: 'SOHRAAB',
    dateOfBirth: '14/04/1997',
    dateOfExpiry: '13/04/2027',
    nationality: 'INDIAN',
    sex: 'M',
    isValid: true,
  };

  const out = normalizeExtracted('PASSPORT', raw);
  assert.equal(out.name, 'SOHRAAB DANISH', 'given name first, the way credits read');
  assert.equal(out.dob, '14/04/1997');
  assert.equal(out.gender, 'M');
  // Passport-only fields are left alone - the confirmation card shows them.
  assert.equal(out.passportNumber, 'Z1234567');
  assert.equal(out.dateOfExpiry, '13/04/2027');
  assert.equal(out.nationality, 'INDIAN');
});

test('a half-read passport does not invent a name', () => {
  const onlySurname = normalizeExtracted('PASSPORT', { surname: 'DANISH' });
  assert.equal(onlySurname.name, 'DANISH');
  const neither = normalizeExtracted('PASSPORT', { passportNumber: 'Z1' });
  assert.equal(neither.name, undefined, 'no name at all, rather than an empty string');
});

// --- GST field normalisation ------------------------------------------

test('GST: real document-OCR shape - legalName is mapped onto the shared name field', () => {
  // Confirmed live against the real POST /api/documents/gst endpoint (a real GST certificate).
  const real = normalizeExtracted('GST', {
    legalName: 'CHOIRA MUSICTECH PRIVATE LIMITED',
    gstin: '27AAJCC8000E1ZZ',
    gstinChecksumValid: true,
    address: '21.Gruhalaxmi Society, Manavseva Nagar, Seminary Hills Nagpur, Nagpur, Maharashtra, 440013',
    pincode: '440013',
    zipCode: '440013',
    isValid: true,
  });
  assert.equal(real.name, 'CHOIRA MUSICTECH PRIVATE LIMITED');
  // Already-named-right fields pass through untouched.
  assert.equal(real.gstin, '27AAJCC8000E1ZZ');
  assert.equal(real.address, '21.Gruhalaxmi Society, Manavseva Nagar, Seminary Hills Nagpur, Nagpur, Maharashtra, 440013');
  assert.equal(real.pincode, '440013');
  assert.equal(real.isValid, true);
});

test('every other document is passed through untouched', () => {
  const aadhaar = { name: 'REAL NAME', dob: '01/01/1990' };
  assert.equal(normalizeExtracted('AADHAAR', aadhaar), aadhaar, 'same object, not a copy');
  assert.equal(normalizeExtracted('PASSPORT', null), null);
});

test('PAN: real document-OCR shape - name is split for First/LastName, fatherName/motherName become parentName', () => {
  // Confirmed live against the real POST /api/documents/pan endpoint (a real PAN card): the
  // response is { pan, name, fatherName, dob, gender, ... } - no full_name_split field exists
  // there, so name itself is what gets split.
  const real = normalizeExtracted('PAN', {
    pan: 'IIUPS8911N',
    name: 'UDAY RAJKUMAR SINGH',
    fatherName: 'RAJKUMAR SINGH',
    dob: '22/02/1999',
    isValid: true,
  });
  assert.equal(real.pan, 'IIUPS8911N');
  assert.equal(real.name, 'UDAY RAJKUMAR SINGH');
  assert.equal(real.firstName, 'UDAY RAJKUMAR', 'first two tokens of name');
  assert.equal(real.lastName, 'SINGH', 'everything after the first two tokens');
  assert.equal(real.parentName, 'RAJKUMAR SINGH');

  // A card with only two name tokens - nothing left over for LastName.
  const twoTokens = normalizeExtracted('PAN', { pan: 'X', name: 'PRIYAL LATHIA' });
  assert.equal(twoTokens.firstName, 'PRIYAL LATHIA');
  assert.equal(twoTokens.lastName, undefined, 'nothing left over, not an empty string');

  // Mother's name instead of father's - either is written, per the member's own instruction.
  const motherOnly = normalizeExtracted('PAN', { pan: 'X', name: 'A B', motherName: 'MOTHER NAME' });
  assert.equal(motherOnly.parentName, 'MOTHER NAME');

  // Both present - both get written, not just whichever comes first.
  const both = normalizeExtracted('PAN', { pan: 'X', name: 'A B', fatherName: 'FATHER NAME', motherName: 'MOTHER NAME' });
  assert.equal(both.parentName, 'FATHER NAME, MOTHER NAME');

  // pan_number/full_name/full_name_split (a different, separate verification API's shape) still
  // work if ever sent - defends against either shape.
  const alt = normalizeExtracted('PAN', {
    pan_number: 'BJFPL1282A',
    full_name: 'PRIYAL HITEN LATHIA',
    full_name_split: ['PRIYAL', 'HITEN', 'LATHIA'],
  });
  assert.equal(alt.pan, 'BJFPL1282A');
  assert.equal(alt.name, 'PRIYAL HITEN LATHIA');
  assert.equal(alt.firstName, 'PRIYAL HITEN');
  assert.equal(alt.lastName, 'LATHIA');
});
