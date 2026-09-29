// ==================================================================
// Gates the Typebot conversation's GST-number step: blocks progression
// until the typed value verifies against the government-lookup service
// (see registration/services/verify/), instead of relaying an unchecked
// answer straight to Typebot. Mirrors workLinkGate.js's variableId-based
// recognition. TAN is NOT wired in here - no Studio question exists for
// it yet, and it isn't being added until asked for.
//
// Pass/fail is decided entirely by the verify provider (see
// httpVerifyProvider.js's pass/fail rule) - this gate just relays the
// provider's verdict, it never re-derives one from the response's `data`.
// ==================================================================
import { createVerifyProvider } from '../../../registration/services/verify/verifyProvider.factory.js';

// Exported (not just a local const) so tests can swap verifyProvider.verify the same way
// emailOtpGate.js's tests swap emailOtpService's methods - verifyValue looks this up at call
// time, so a monkey-patched method is picked up without restructuring anything else here.
export const verifyProvider = createVerifyProvider();

// The GST question's variableId - same literal id already mapped to Detail1 in
// conversationFieldMap.js. Update both if that block's variable is re-created in Studio.
export const GSTIN_VARIABLE_ID = 'vqpmuqooo8wn2ktrfx9uf4l1j';

const GSTIN_STEP = { variableId: GSTIN_VARIABLE_ID, docType: 'GSTIN', label: 'GST number' };

// -> the matching step config, or null if this variableId isn't a verify step.
export function matchVerifyStep(variableId) {
  return variableId === GSTIN_VARIABLE_ID ? GSTIN_STEP : null;
}

export const verifyValue = (docType, value) => verifyProvider.verify({ docType, value });

// The registry's own wording arrives verbatim and does not always end a
// sentence - "GSTIN not found" ran straight into the line after it.
const asSentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

export function describeVerifyFailure(label, message) {
  const reason = message?.trim() ? asSentence(message.trim()) : `We couldn't verify that ${label}.`;
  return `${reason} Please check it and enter it again.`;
}

// Distinct from describeVerifyFailure: this path fires on a genuine service/transport problem
// (see httpVerifyProvider.js's pass/fail rule), not a "no" answer. When the service DID respond
// with its own reason (e.g. a malformed-GSTIN rejection, still success:false) that reason is
// member-facing and worth showing - it tells them what to fix, same as describeVerifyFailure's
// wording. Only a true network/transport failure (no body reason at all) falls back to the
// generic, retry-safe wording.
export function describeVerifyError(label, reason) {
  const trimmed = reason?.trim();
  if (trimmed) return `${asSentence(trimmed)} Please check it and enter it again.`;
  return `We're having trouble verifying that ${label} right now. Please try entering it again in a moment.`;
}
