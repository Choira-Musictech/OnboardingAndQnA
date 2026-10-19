// ==================================================================
// Holds the payment button until the member has e-signed their application form.
//
// Order at the end of the flow: review -> sign -> payment. Typebot itself knows nothing about
// signing - it offers the payment button as before (see paymentGate.js). When signing is required
// and not done yet, the engine keeps showing the review, adds the "please sign" message and marks
// the response `signRequired: true`; the frontend then shows the sign card instead of the payment
// button. payment.service.js refuses /payment/initiate on its own as well, so the order holds even
// for a client that ignores the flag.
//
// Whether signing is needed and done is read from the database (esign.service.js), so a member who
// logs out halfway and comes back lands on the right step.
// ==================================================================
import { logger } from '../../../../utils/logger.js';
import { esignService } from '../../../esign/services/esign.service.js';

export const SIGNATURE_STATE = Object.freeze({
  NOT_REQUIRED: 'not-required',
  REQUIRED: 'required', // must sign, has not yet
  SIGNED: 'signed',
  UNKNOWN: 'unknown', // the lookup failed (e.g. the e-sign table is missing) - claim nothing
});

/** Where this member stands with signing. Never throws. */
export async function signatureState(userId) {
  try {
    if (!(await esignService.isRequired(userId))) return SIGNATURE_STATE.NOT_REQUIRED;
    return (await esignService.isSigned(userId)) ? SIGNATURE_STATE.SIGNED : SIGNATURE_STATE.REQUIRED;
  } catch (err) {
    // payment.service.js checks again before any payment starts, so a lookup failure here only
    // costs the member a clear message, never lets an unsigned payment through. The chat must not
    // say "signed" on a failed lookup, which is why this is its own state rather than `false`.
    logger.warn({ userId, err: err.message }, 'Could not check whether the application is signed');
    return SIGNATURE_STATE.UNKNOWN;
  }
}

/** True when this member must still sign before paying. Never throws. */
export async function needsSignature(userId) {
  return (await signatureState(userId)) === SIGNATURE_STATE.REQUIRED;
}

/**
 * True when this member has already signed. Once signed, their answers are confirmed - the chat never
 * offers them "Start over" (it would throw away details they signed). Never throws.
 */
export async function isApplicationSigned(userId) {
  try {
    return await esignService.isSigned(userId);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Could not check whether the application is signed');
    return false;
  }
}

/** 'EMSIGNER' (Aadhaar, Indian members) or 'DOCUSIGN' (NRI), null when signing does not apply. Never throws. */
export async function signProviderFor(userId) {
  try {
    return await esignService.providerForUser(userId);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Could not look up the signing provider');
    return null;
  }
}

// The wording names how they will sign: Aadhaar OTP for Indian members, DocuSign for NRI members.
export function describeSignRequired(provider) {
  if (provider === 'DOCUSIGN') {
    return 'Please sign your application before payment. Tap "Sign application" to review the form and sign it online with DocuSign.';
  }
  return 'Please sign your application before payment. Tap "Sign application" to review the form and sign it with your Aadhaar OTP.';
}

// Shown under the review once the signature is in and only the payment is left.
export function describeSignDone() {
  return 'Your application is signed. Check your details above, then tap "Pay Application Fee" to complete your registration.';
}

// Shown when the member types into the chat while the signature is still pending.
export function describeSignPending() {
  return "Your application isn't signed yet. Please tap \"Sign application\" to sign it - payment opens right after.";
}
