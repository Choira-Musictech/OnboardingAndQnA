// ==================================================================
// Gates the Typebot conversation's "Provide your email id" step:
// blocks progression until the answered email is OTP-verified via the
// existing emailOtpService (send-email-otp/verify-email-otp). Mirrors
// workLinkGate.js's variableId-based recognition, but this step needs a
// send-then-verify sub-conversation rather than a single pass/fail check.
// ==================================================================
import { env } from '../../../config/env.js';
import { emailOtpService } from '../../auth/services/emailOtp.service.js';

// The "Provide your email id" email-input block's variableId in the
// current Typebot flow - same id already mapped to AccountEmail in
// conversationFieldMap.js. Update both if that block's variable is
// re-created in Studio.
export const EMAIL_VARIABLE_ID = 'virpfcnue17syf7ua2hbuj5d1';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailStep(variableId) {
  return variableId === EMAIL_VARIABLE_ID;
}

export function isValidEmail(value) {
  return EMAIL_RE.test(String(value ?? '').trim());
}

export const sendVerificationOtp = (email) => emailOtpService.sendEmailOtp({ email });
export const verifyVerificationOtp = (email, otp) => emailOtpService.verifyEmailOtp({ email, otp });

// --- What the member may type (or tap) at the OTP step ----------------------
//
// The frontend now also shows "Resend OTP"/"Change email" as buttons (registrationEngine.js's
// EMAIL_OTP_INPUT), but a button tap arrives here exactly like typed text - sendAnswer() posts the
// button's own label as the message. These keyword lists are what actually decide the match, so
// they cover both the button labels and the typed phrasings members already used before the
// buttons existed.

function normalize(message) {
  return String(message ?? '').trim().toLowerCase();
}

export function isResendKeyword(message) {
  return ['resend', 'resend otp', 'resend the otp', 'send otp again', 'send again', 'new otp'].includes(normalize(message));
}

// Without this the step is a dead end: a mistyped address never receives a code, every OTP guess
// fails, and `resend` mails the same wrong address again. The only escape used to be abandoning the
// whole registration.
export function isChangeEmailKeyword(message) {
  return ['change', 'change email', 'change my email', 'wrong email', 'edit email', 'different email'].includes(normalize(message));
}

// Capped because each change sends mail to an address the member names, and the 60-second resend
// cooldown doesn't apply across different addresses - uncapped, one session could flood arbitrary
// inboxes from this project's SMTP account. Three covers a real typo several times over.
export const MAX_EMAIL_CHANGES = 3;

export function describeOtpSent(email) {
  return `We've sent a 4-digit OTP to ${email}. Enter it to verify, or tap Resend OTP for a new code, or Change email to use a different address.`;
}

// "Resend OTP" / "Change email" arrived but there is no code on its way any more (the session was
// lost, e.g. a refresh or a server restart). They are buttons, not addresses - ask for the address.
export function describeEmailNeededAgain() {
  return 'Please enter your email address again and we will send you a new OTP.';
}

export function describeOtpProblem(reason) {
  return `${reason} Tap Resend OTP for a new code, or Change email to use a different address.`;
}

export function describeChangeLimitReached() {
  const contact = env.SUPPORT_CONTACT?.trim();
  const where = contact ? `please write to ${contact}` : 'our team will get in touch with you';
  return `You've already changed your email address ${MAX_EMAIL_CHANGES} times - ${where}. If a code still reaches you, you can enter it here.`;
}
