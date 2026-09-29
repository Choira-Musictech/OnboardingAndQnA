// ==================================================================
// Holds the conversation at the payment button long enough to show the
// member everything on file.
//
// TWO THINGS ARE DIFFERENT HERE, both easy to trip over later:
//
// 1. This gate keys off the **block id**, not a variableId - see
//    paymentBlockIds.js, which owns the four ids and explains why. They
//    live in their own module so the progress-map build script can check
//    them without importing this file's env/Prisma dependencies.
//
// 2. It intercepts Typebot's **reply**, not the member's answer. Every
//    other gate inspects the message coming in; this one inspects the
//    input going back out, because the trigger is "Typebot just offered
//    the payment button".
//
// 3. A payment block is a TERMINAL state: once the member is parked on one,
//    handle() never relays their next message to Typebot. Every one of these
//    four blocks leads to a single "Thank you for your payment." text and
//    then the flow ends, so relaying anything at all made Typebot congratulate
//    a member who had not paid (and ended the session, wiping their journal).
//    Real payment runs entirely outside Typebot, through /payment/initiate and
//    the PayU callback, so that closing message is now dead - the frontend's
//    own success page is the closure.
//
// Four blocks - one per role path.
// ==================================================================
import { env } from '../../../../config/env.js';
import { renderSections } from '../../../registration/services/registrationReview.service.js';

export { isPaymentStep, PAYMENT_BLOCK_IDS } from './paymentBlockIds.js';

// Rendering itself (a line with a label -> "Label: value", one without -> a plain bullet, which is
// what lists of documents and songs want) lives in registrationReview.service.js's renderSections()
// - the resume summary in registrationEngine.js wants the same body under a different intro line.
export function describeReview(sections) {
  return `Please check your details before payment.\n\n${renderSections(sections)}`;
}

// Shown when the member types something while parked on the payment button instead of going
// through checkout - the old behaviour was to hand that text to Typebot, which happily read it as
// "Pay Application Fee" and thanked them for a payment that never happened.
export function describePaymentPending() {
  return "We haven't received your payment yet. Please tap the payment button above to complete it - your details are saved, so nothing is lost.";
}

// Payment is in, but complete() is still refusing - the member only ever reaches this if something
// required is missing, since a completed registration routes them to the Q&A engine instead.
export function describePaymentReceived(registrationId) {
  const contact = env.SUPPORT_CONTACT?.trim();
  const where = contact
    ? `Please write to ${contact} and we'll finish it for you.`
    : 'Our team will get in touch with you to finish it.';

  return `We've received your payment - thank you. Your registration still needs a final check before it can be activated.\n\n${where}\n\nQuote your registration number: ${registrationId}`;
}
