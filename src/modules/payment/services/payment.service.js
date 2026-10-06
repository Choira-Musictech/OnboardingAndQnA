// ==================================================================
// Payment service - PayU checkout orchestration, hash computation,
// callback processing, and status reconciliation.
//
// Writes to App_Accounts_RegPayment, IPRS's real registration-payment table (see
// prisma/schema.prisma's AppAccountsRegPayment doc comment) - not a table this app invented for
// itself. PaymentStatus semantics, confirmed by IPRS's own team (not guessed):
//   0 = success, 1 = not-yet-confirmed (covers both "still pending" and "failed" - IPRS's own
//   system does not distinguish them at the DB level either).
// A row is created the moment a payment is initiated, at PaymentStatus 1. IPRS runs a scheduler
// every ~3 hours that re-checks every row still at 1 against the gateway and flips it to 0 on
// success - so this app must leave a row at 1 for a failed/unconfirmed attempt, never delete it
// or represent "not yet paid" as a missing row.
// ==================================================================
import crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { badRequestError, conflictError, forbiddenError, notFoundError } from '../../../shared/errors.js';
import { userRepository } from '../../user/repositories/user.repository.js';
import { registrationService } from '../../registration/services/registration.service.js';
import { conversationJournalService } from '../../conversation/services/conversationJournal.service.js';
import { typebotSessionStore } from '../../conversation/services/typebot/typebotSessionStore.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import { formatAmount, generatePayuHash, verifyPayuHash } from './payu/payu.utils.js';
import { payuClient } from './payu/payu.client.js';
import { resolveFee } from './payu/feeSchedule.js';

// The shape this service's callers see. PENDING/FAILED are both stored as PaymentStatus 1 (see
// the module doc comment) - the distinction between them is made live, only in what's returned
// here, never persisted differently.
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

// Confirmed by IPRS's team, not guessed.
const REG_PAYMENT_STATUS_CODE = Object.freeze({ SUCCESS: 0, UNCONFIRMED: 1 });

function generateTxnId(userId) {
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  return `IPRS_${userId}_${Date.now()}_${randomSuffix}`;
}

// The one-time "you're done" card, shown as a normal chat bubble once registration is genuinely
// complete (not just paid-for - see the two call sites below). AccountId doubles as the
// "Application Number" here, same identifier paymentGate.js's describePaymentReceived() already
// calls "your registration number"; IPRS Email ID is the same org-wide support address members
// are already told to write to, not a per-member mailbox (nothing like that exists in this app).
//
// Shown once per account, ever (this process's lifetime) - guards against the same card appearing
// twice back-to-back when more than one code path reaches "registration is complete" for the same
// account (a repeat payment-status poll, a session resume via aiEngine, or both in one page load).
const registrationCompleteNotified = new Set();

function registrationCompleteText(registrationId) {
  if (registrationCompleteNotified.has(registrationId)) return null;
  registrationCompleteNotified.add(registrationId);
  const contact = env.SUPPORT_CONTACT?.trim();
  const emailLine = contact ? `\nIPRS Email ID: ${contact}` : '';
  return (
    `Thank You for Registration!\n\n` +
    `Application Number: ${registrationId}${emailLine}\n\n` +
    `You will receive a confirmation email from the IPRS team.`
  );
}

function registrationCompleteMessage(registrationId) {
  const text = registrationCompleteText(registrationId);
  if (!text) return null;
  return {
    id: 'registration-complete',
    type: 'text',
    content: { type: 'richText', richText: [{ type: 'p', children: [{ text }] }] },
  };
}

// Default mapping for a row read on its own, with no live gateway check behind it (e.g.
// getPaymentHistory). PaymentStatus 1 defaults to PENDING rather than FAILED - the row alone
// can't tell a freshly-initiated attempt from one PayU already told us failed, and reporting
// "failed" for one that's actually still processing is the worse mistake to make by default.
function toPublic(payment) {
  if (!payment) return null;
  const status =
    payment.PaymentStatus === REG_PAYMENT_STATUS_CODE.SUCCESS ? PAYMENT_STATUS.SUCCESS : PAYMENT_STATUS.PENDING;
  return {
    paymentId: String(payment.PaymentRecieptId),
    userId: String(payment.AccountId),
    txnId: payment.TransactionNo,
    mihPayId: payment.ResponseNo ?? null,
    amount: payment.PaymentAmount,
    status,
    errorMessage: null,
    createdAt: payment.CreateDate,
    updatedAt: payment.ModifedDate,
  };
}

/**
 * Initiates a new PayU payment transaction for the member. The amount is never taken from the
 * caller - it's resolved server-side from the member's own registration type (AccountRegType),
 * already saved during the Typebot conversation, via feeSchedule.js. This is what stops a member
 * paying whatever they like instead of their actual membership fee.
 */
// The chatbot is served on more than one domain, and a browser's login token belongs to exactly
// one of them. PayU always returns through this backend, so the member's own site is remembered
// here at initiation and used for the final redirect - sending them back to a different domain
// logs them out mid-payment and shows a login or failure screen after a payment that succeeded.
// Only origins on the allow-list are honoured, so the redirect can never be pointed elsewhere.
const RETURN_ORIGINS = new Map();
const MAX_REMEMBERED_RETURNS = 500;

function allowedReturnOrigins() {
  const allowed = new Set();
  for (const url of [env.PAYU_SUCCESS_URL, env.PAYU_FAILURE_URL]) {
    try {
      if (url) allowed.add(new URL(url).origin);
    } catch {
      /* a malformed env value simply contributes nothing */
    }
  }
  for (const item of String(env.PAYU_RETURN_ORIGINS ?? '').split(',')) {
    const trimmed = item.trim();
    if (trimmed) allowed.add(trimmed.replace(/\/+$/, ''));
  }
  return allowed;
}

function rememberReturnOrigin(txnId, origin) {
  if (!txnId || !origin || !allowedReturnOrigins().has(origin)) return;
  // A payment round-trip is minutes; this cap stops a long-running process growing without bound.
  if (RETURN_ORIGINS.size >= MAX_REMEMBERED_RETURNS) {
    RETURN_ORIGINS.delete(RETURN_ORIGINS.keys().next().value);
  }
  RETURN_ORIGINS.set(txnId, origin);
}

/** The site this payment began on, consumed once. Null falls back to the configured URLs. */
function takeReturnOrigin(txnId) {
  const origin = RETURN_ORIGINS.get(txnId) ?? null;
  RETURN_ORIGINS.delete(txnId);
  return origin;
}

async function initiatePayment({ userId, productInfo, returnOrigin }) {
  const account = await userRepository.findById(userId);
  if (!account) {
    throw notFoundError('User not found');
  }

  const numAmount = resolveFee(account.AccountRegType);
  if (numAmount == null) {
    // Either the member hasn't reached the opening path question yet, or the flow's wording
    // changed and memberRoleCodes.js's mapping is stale - either way, guessing a fee here would be
    // worse than refusing to start a payment for it.
    throw badRequestError('Registration incomplete: registration type not yet determined, cannot compute fee', {
      errorCode: 'REGISTRATION_INCOMPLETE',
      details: { accountRegType: account.AccountRegType ?? null },
    });
  }

  // The payment button is a terminal state in our flow, but nothing stops a stale chat tab (or a
  // back button) from firing this a second time - and every call mints a fresh PayU checkout the
  // member could actually go through with. Only a real SUCCESS blocks: an abandoned/unconfirmed
  // attempt stays at PaymentStatus 1, and locking those members out of retrying would be worse.
  if (await paymentRepository.hasSuccessfulPayment(userId)) {
    throw conflictError('This registration has already been paid for', {
      errorCode: 'PAYMENT_ALREADY_COMPLETED',
    });
  }

  const txnId = generateTxnId(userId);
  const formattedAmount = formatAmount(numAmount);
  const info = String(productInfo || 'IPRS Membership Onboarding Fee').trim();
  const customerName = (account.AccountName || account.FirstName || 'Member').trim();
  const customerEmail = (account.AccountEmail || '').trim();
  const customerPhone = (account.AccountMobile || '').trim();
  const udf1 = String(userId);

  const hash = generatePayuHash({
    key: env.PAYU_KEY,
    txnid: txnId,
    amount: formattedAmount,
    productinfo: info,
    firstname: customerName,
    email: customerEmail,
    udf1,
    salt: env.PAYU_SALT,
  });

  // Row exists from the moment of initiation, at PaymentStatus 1 - this is what IPRS's own
  // 3-hourly reconciliation scheduler expects to find and re-check (see the module doc comment).
  await paymentRepository.createResult({
    AccountId: userId,
    TransactionNo: txnId,
    PaymentStatus: REG_PAYMENT_STATUS_CODE.UNCONFIRMED,
    PaymentAmount: numAmount,
    PaidAmount: '0',
    PaymentDate: new Date(),
    CreateDate: new Date(),
    CreatedBy: customerName,
    ModifedBy: customerName || null,
    ModifedDate: new Date(),
  });

  logger.info({ userId, txnId, amount: numAmount }, 'Initiated PayU payment transaction');

  const actionUrl = `${env.PAYU_BASE_URL.replace(/\/+$/, '')}/_payment`;

  rememberReturnOrigin(txnId, returnOrigin);

  return {
    key: env.PAYU_KEY,
    txnId,
    amount: formattedAmount,
    currency: 'INR',
    hash,
    actionUrl,
    params: {
      key: env.PAYU_KEY,
      txnid: txnId,
      amount: formattedAmount,
      productinfo: info,
      firstname: customerName,
      email: customerEmail,
      phone: customerPhone,
      // PayU must POST its result to OUR backend, not straight to a frontend page - PAYU_CALLBACK_URL
      // is that endpoint (this service's own POST /payment/callback). Falls back to
      // PAYU_SUCCESS_URL/FAILURE_URL only when it's unset, matching this code's old behaviour.
      surl: env.PAYU_CALLBACK_URL || env.PAYU_SUCCESS_URL || '',
      furl: env.PAYU_CALLBACK_URL || env.PAYU_FAILURE_URL || '',
      hash,
      udf1,
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: '',
    },
  };
}

/**
 * Handles PayU callback / webhook / redirect response.
 */
async function handlePayuCallback(payuPayload) {
  if (!payuPayload || typeof payuPayload !== 'object') {
    throw badRequestError('Invalid payment callback payload');
  }

  const txnId = payuPayload.txnid;
  if (!txnId) {
    throw badRequestError('Missing transaction ID (txnid) in callback payload');
  }

  const isValidSignature = verifyPayuHash(payuPayload, env.PAYU_SALT);

  if (!isValidSignature) {
    logger.warn({ txnId, payload: payuPayload }, 'PayU callback signature verification failed');
    throw badRequestError('Invalid payment signature');
  }

  const existing = await paymentRepository.findByTxnId(txnId);
  if (!existing) {
    // Should not happen - initiatePayment() always creates the row - but a callback for a
    // transaction we truly have no record of at all is not something to silently accept.
    logger.warn({ txnId }, 'PayU callback received for unknown transaction ID');
    throw notFoundError('Payment transaction not found');
  }

  const rawStatus = String(payuPayload.status || '').trim().toLowerCase();
  const isSuccess = rawStatus === 'success';
  const responseString = new URLSearchParams(
    Object.entries(payuPayload).filter(([, v]) => v != null),
  ).toString();

  const saved = await paymentRepository.updateResultByTxnId(txnId, {
    // Stays at UNCONFIRMED (1) on failure - not a separate "failed" code, matching IPRS's own
    // scheduler semantics (see the module doc comment).
    PaymentStatus: isSuccess ? REG_PAYMENT_STATUS_CODE.SUCCESS : REG_PAYMENT_STATUS_CODE.UNCONFIRMED,
    PaymentGatewayResponse: isSuccess ? 'Status=success' : `Status=failure--${(payuPayload.error_Message || payuPayload.unmappedstatus || 'Payment failed')}`.slice(0, 500),
    ResponseNo: payuPayload.mihpayid ? String(payuPayload.mihpayid) : null,
    ResponseString: responseString,
    PaymentBankName: payuPayload.bankcode || null,
    PaidAmount: isSuccess ? String(payuPayload.amount ?? existing.PaymentAmount ?? '') : '0',
  });

  logger.info(
    { userId: String(saved.AccountId), txnId, isSuccess, mihpayid: payuPayload.mihpayid },
    'Processed PayU payment callback',
  );

  // If successful, attempt to mark the registration complete
  if (isSuccess) {
    const userIdStr = String(saved.AccountId);
    try {
      await registrationService.complete(userIdStr, userIdStr);
      logger.info({ userId: userIdStr, txnId }, 'Registration completed on payment confirmation');

      // The member's Typebot session is still parked on the payment button - it is never driven
      // past it (see paymentGate.js), so without this it would dangle until the process restarts.
      // Clearing both is only safe once complete() has actually succeeded: if it threw, the member
      // still needs the journal to resume and finish whatever is missing.
      typebotSessionStore.clear(userIdStr);
      await conversationJournalService.clearJournal(userIdStr);
    } catch (err) {
      // Money has changed hands and the member is still not registered - that is not info-level.
      logger.warn(
        { userId: userIdStr, txnId, err: err.message },
        'Payment succeeded but the registration could not be completed (documents or info still pending)',
      );
    }
  }

  // This callback just got a definite answer from PayU itself, right now - report it precisely
  // (SUCCESS/FAILED), rather than toPublic()'s more cautious PENDING default for an unconfirmed
  // row (that default is for a row read with no live context behind it, which this isn't).
  return {
    ...toPublic(saved),
    status: isSuccess ? PAYMENT_STATUS.SUCCESS : PAYMENT_STATUS.FAILED,
    errorMessage: isSuccess ? null : (payuPayload.error_Message || payuPayload.unmappedstatus || 'Payment failed'),
  };
}

/**
 * Checks or verifies the payment status of a transaction for the authenticated member. A row at
 * PaymentStatus 1 (unconfirmed) triggers the same live PayU verify_payment webservice check
 * IPRS's own 3-hourly scheduler performs - this is just the on-demand equivalent of it. Only ever
 * writes PaymentStatus 0 on a confirmed success; a live-confirmed failure or "still no info" both
 * leave the row at 1 for the scheduler (or the next check here) to retry later.
 */
async function verifyPaymentStatus({ userId, txnId }) {
  const existing = await paymentRepository.findByTxnId(txnId);
  if (!existing) {
    throw notFoundError('Transaction not found');
  }

  if (String(existing.AccountId) !== String(userId)) {
    throw forbiddenError('Transaction does not belong to the authenticated user');
  }

  if (existing.PaymentStatus === REG_PAYMENT_STATUS_CODE.SUCCESS) {
    const { completed } = await registrationService.getStatus(userId);
    const result = toPublic(existing);
    if (!completed) return result;
    const card = registrationCompleteMessage(userId);
    return card ? { ...result, messages: [card] } : result;
  }

  const check = await payuClient.verifyPayment(txnId);
  if (!check.verified && !check.transaction) {
    // PayU has no definite info either - genuinely still pending, row stays untouched.
    return toPublic(existing);
  }

  const details = check.transaction;
  const isSuccess = details.status?.toLowerCase() === 'success';

  if (isSuccess) {
    const updated = await paymentRepository.updateResultByTxnId(txnId, {
      PaymentStatus: REG_PAYMENT_STATUS_CODE.SUCCESS,
      PaymentGatewayResponse: 'Status=success',
      ResponseNo: details.mihpayid ? String(details.mihpayid) : existing.ResponseNo,
      ResponseString: JSON.stringify(check.raw ?? {}),
      PaymentBankName: details.bankcode || existing.PaymentBankName,
      PaidAmount: String(existing.PaymentAmount ?? ''),
    });

    let completed = false;
    try {
      const userIdStr = String(updated.AccountId);
      await registrationService.complete(userIdStr, userIdStr);
      completed = true;
    } catch {
      // registration genuinely isn't complete yet (missing docs/info) - describePaymentReceived()
      // already guides the member to contact support on their next chat turn; no error here.
    }

    const result = toPublic(updated);
    if (!completed) return result;
    const card = registrationCompleteMessage(userId);
    return card ? { ...result, messages: [card] } : result;
  }

  // PayU confirms this did NOT succeed - tell the caller precisely, but leave the row at 1
  // (unconfirmed), matching IPRS's own scheduler semantics rather than inventing a separate
  // "failed" code.
  return {
    ...toPublic(existing),
    status: PAYMENT_STATUS.FAILED,
    errorMessage: details.error_Message || details.unmappedstatus || 'Payment failed',
  };
}

/**
 * Gets all payment transactions for the member.
 */
async function getPaymentHistory(userId) {
  const payments = await paymentRepository.findPaymentsByAccountId(userId);
  return payments.map(toPublic);
}

/**
 * Has this member's registration fee actually been paid? Exposed on the service (rather than
 * letting callers reach for the repository) so the conversation engine can ask without crossing
 * into another module's data-access layer.
 */
function hasSuccessfulPayment(userId) {
  return paymentRepository.hasSuccessfulPayment(userId);
}

export const paymentService = {
  initiatePayment,
  takeReturnOrigin,
  handlePayuCallback,
  verifyPaymentStatus,
  getPaymentHistory,
  hasSuccessfulPayment,
  registrationCompleteText,
  PAYMENT_STATUS,
  toPublic,
};
