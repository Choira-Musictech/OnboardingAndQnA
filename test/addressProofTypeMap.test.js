// ==================================================================
// addressProofTypeMap.js's answer-to-OCR-type resolution (node:test).
// No DB, no network - pure functions.
//
// WHY THIS FILE EXISTS: this map has drifted silently before - "Electricity
// Bill" vs the live button's actual "Electricity/Light Bill" text (see
// AGENTS.md) skipped OCR for every real selection until caught by a live
// builder-API check, not a test. Pins the current live button texts
// (confirmed via the builder API) so a Studio republish that renames one of
// these is caught here instead of silently in production.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAddressProofOcrType, isManualAddressAnswer } from '../src/modules/conversation/services/typebot/addressProofTypeMap.js';

test('every address-proof answer with a live OCR endpoint resolves', () => {
  assert.equal(resolveAddressProofOcrType('Driving Licence'), 'DRIVING_LICENCE');
  assert.equal(resolveAddressProofOcrType('Voter ID'), 'VOTER_ID');
  assert.equal(resolveAddressProofOcrType('Passport'), 'PASSPORT');
  assert.equal(resolveAddressProofOcrType('Electricity/Light Bill'), 'ELECTRICITY');
  assert.equal(resolveAddressProofOcrType('GST Certificate'), 'GST');
});

test('resolution is case/whitespace-tolerant', () => {
  assert.equal(resolveAddressProofOcrType('  gst certificate  '), 'GST');
  assert.equal(resolveAddressProofOcrType('GST CERTIFICATE'), 'GST');
});

test('answers with no OCR endpoint resolve to null, not a wrong guess', () => {
  for (const answer of ['Letter from Property Owner', 'Telephone Bill', 'Mobile Bill', 'Rent Agreement', 'letter from Owner']) {
    assert.equal(resolveAddressProofOcrType(answer), null, answer);
  }
  assert.equal(resolveAddressProofOcrType('something unrecognised'), null);
});

test('the "type it instead" answers are recognised as manual, not unresolved', () => {
  assert.equal(isManualAddressAnswer('Type your address'), true);
  assert.equal(isManualAddressAnswer('Type registered address'), true);
  assert.equal(isManualAddressAnswer('Type communication address'), true);
  assert.equal(isManualAddressAnswer('GST Certificate'), false);
});
