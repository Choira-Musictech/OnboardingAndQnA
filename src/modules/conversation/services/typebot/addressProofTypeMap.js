// ==================================================================
// The new Typebot flow replaced the old dedicated Aadhaar upload with a
// generalized "address proof" flow (asked twice: permanent, then
// current-only-if-different): the user first picks a document type from
// a choice input (Passport / Electricity Bill / Driving Licence / Voter
// ID / Letter from Property Owner), then uploads a file into a SEPARATE
// variable (permanent_address_proof / current_address_proof) that
// doesn't itself say which type it is. This map lets registrationEngine.js
// remember the chosen type across that one-turn gap, so the paired file
// upload can route to the right OCR endpoint (or skip OCR entirely for
// the 3 types with no OCR support anywhere).
// ==================================================================

// The two "what type of document is this?" choice-input blocks' variableIds.
export const ADDRESS_PROOF_TYPE_VARIABLE_IDS = {
  vwtm9i19qrzl3dxjzifdw6xnp: 'permanent', // address_proof_type_permanent
  vgbmeklrpc3b4hu8tvmodnt4e: 'current', // address_proof_type_current
};

// 5 of the address-proof choices have a live OCR endpoint (per the "Document Verification API").
// "Letter from Property Owner"/"Telephone Bill"/"Mobile Bill"/"Rent Agreement" have none anywhere
// (not government/utility documents with an OCR endpoint) and map to null - no OCR, saved as-is
// (same treatment as NOC).
const OCR_TYPE_BY_ANSWER = {
  'driving licence': 'DRIVING_LICENCE',
  'voter id': 'VOTER_ID',
  passport: 'PASSPORT',
  // Live button text is "Electricity/Light Bill" (confirmed via the builder API), not
  // "Electricity Bill" - a stale guess here silently skipped OCR for every real selection.
  'electricity/light bill': 'ELECTRICITY',
  // Live button text confirmed via the builder API on the company/NRI paths' address-proof
  // choice blocks (kg2i35l2491u5hopas7stdg4 and friends) - "GST Certificate" verbatim.
  'gst certificate': 'GST',
};

export function isAddressProofTypeStep(variableId) {
  return variableId in ADDRESS_PROOF_TYPE_VARIABLE_IDS;
}

export function resolveAddressProofOcrType(answerText) {
  return OCR_TYPE_BY_ANSWER[String(answerText ?? '').trim().toLowerCase()] ?? null;
}

// Several paths add a "type it instead of uploading" choice to their address-proof-type question -
// picking it skips the file-upload step entirely and branches straight to a text-input block
// (P_address/c_address for the NRI individual path, registered_address_type/comm_address2_type for
// the company paths - all in conversationFieldMap.js) instead. Not an unresolved OCR type, so
// callers should skip the "did not resolve" warning for these answers.
const MANUAL_ADDRESS_ANSWERS = new Set([
  'type your address',
  'type registered address',
  'type communication address',
]);

export function isManualAddressAnswer(answerText) {
  return MANUAL_ADDRESS_ANSWERS.has(String(answerText ?? '').trim().toLowerCase());
}
