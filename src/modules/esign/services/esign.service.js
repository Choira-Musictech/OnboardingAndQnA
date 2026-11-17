// ==================================================================
// E-signing of the member's application form - review -> payment -> sign -> registration complete.
//
// Who signs with what: see esignPolicy.js (Indian members eMudhra Aadhaar eSign, NRI DocuSign).
//
// Rules this service keeps (from IPRS's integration guide):
//   - The App_Accounts_ESign row exists BEFORE the member is sent to the provider, and the return
//     URL carries that row's id - a return is only ever matched to a row we created.
//   - A return is never trusted as proof. The provider is asked for the workflow status, and only
//     "Completed" downloads the signed PDF and marks the row COMPLETED.
//   - The member signs after paying. The registration completes only once there is a COMPLETED
//     row (registration.service.js's complete() checks it), and refresh() completes it right then.
// ==================================================================
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env.js';
import { appError, badRequestError, conflictError, forbiddenError, notFoundError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';
import { registrationRepository } from '../../registration/repositories/registration.repository.js';
import { registrationService } from '../../registration/services/registration.service.js';
import { paymentRepository } from '../../payment/repositories/payment.repository.js';
import { conversationJournalService } from '../../conversation/services/conversationJournal.service.js';
import { typebotSessionStore } from '../../conversation/services/typebot/typebotSessionStore.js';
import { esignRepository } from '../repositories/esign.repository.js';
import { SIGNATURE_BOX } from '../templates/applicationForm.js';
import { applicationPdfService } from './applicationPdf.service.js';
import { SIGNED_APPLICATION_DOCUMENT } from './applicationData.service.js';
import { docuSignClient } from './docusign.client.js';
import { emSignerClient } from './emsigner.client.js';
import { DECLARATION_BOX, signatureBoxesFor } from './signaturePlacement.js';
import { ESIGN_PROVIDERS, esignPolicy } from './esignPolicy.js';

export { ESIGN_PROVIDERS };
export const ESIGN_STATUS = Object.freeze({ INITIATED: 'INITIATED', COMPLETED: 'COMPLETED', FAILED: 'FAILED' });

// Provider statuses that mean the member can no longer sign this workflow / envelope
// (emSigner workflowStatus, DocuSign envelope status).
const DEAD_STATUSES = ['recalled', 'expired', 'rejected', 'declined', 'voided'];

// An unfinished emSigner link is reused for this long instead of starting a second workflow.
// (DocuSign links work once, so an unfinished envelope always gets a fresh link instead.)
const REUSE_OPEN_SIGNING_MS = 30 * 60_000;

// Swappable in tests, same technique verifyGate.js's verifyProvider export uses.
export const esignProviders = { emSigner: emSignerClient, docuSign: docuSignClient };

function clientFor(provider) {
  return provider === ESIGN_PROVIDERS.DOCUSIGN ? esignProviders.docuSign : esignProviders.emSigner;
}

function providerFor(account) {
  return esignPolicy.providerFor(account);
}

/** Which provider this member signs with (null when e-signing does not apply to them). */
async function providerForUser(userId) {
  return providerFor(await registrationRepository.findByAccountId(userId));
}

/** Whether this member must sign (after paying) before the registration can complete. */
function isRequiredFor(account) {
  return esignPolicy.isRequiredFor(account);
}

async function isRequired(userId) {
  return isRequiredFor(await registrationRepository.findByAccountId(userId));
}

async function isSigned(userId) {
  return esignPolicy.isSigned(userId);
}

// The signature was the last thing missing (the member pays first), so the registration completes
// here: ApplicationStatus 1 and the completion emails. Best-effort - the signature is already saved,
// and anything else still missing is left for the chat / support, never thrown at the provider return.
async function completeRegistration(accountId) {
  const userId = String(accountId);
  try {
    await registrationService.complete(userId, userId);
    logger.info({ userId }, 'Registration completed on signing');
    // Same cleanup as the payment callback: the member's chat is done, the journal is not needed.
    typebotSessionStore.clear(userId);
    await conversationJournalService.clearJournal(userId);
  } catch (err) {
    logger.warn({ userId, err: err.message, missing: err.details?.missing }, 'Signed, but the registration could not be completed yet');
  }
}

// PDFs live under ESIGN_STORAGE_DIR/<AccountId>/; the stored path is relative to the backend folder.
async function savePdf(accountId, fileName, pdf) {
  const relative = path.join(env.ESIGN_STORAGE_DIR, String(accountId), fileName);
  const absolute = path.resolve(relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, pdf);
  return relative.split(path.sep).join('/');
}

// The declaration box and the Work Notification page's box, like DocuSign's two tabs. If the second
// cannot be located, the member still signs the declaration rather than not at all.
async function emSignerBoxes(pdf, userId) {
  try {
    const boxes = await signatureBoxesFor(pdf);
    if (boxes.length < 2) logger.warn({ userId }, 'Work Notification signature spot not found; signing the declaration only');
    return boxes;
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Could not read the signature spots from the PDF; signing the declaration only');
    return [DECLARATION_BOX];
  }
}

function returnUrlFor(eSignId, provider) {
  const base = provider === ESIGN_PROVIDERS.DOCUSIGN ? env.DOCUSIGN_RETURN_URL : env.EMSIGNER_RETURN_URL;
  if (!base) {
    throw appError('E-signing return URL is not configured', { statusCode: 503, errorCode: 'ESIGN_NOT_CONFIGURED' });
  }
  const url = new URL(base);
  url.searchParams.set('esign', String(eSignId));
  return url.toString();
}

function toPublic(row, required) {
  return {
    required,
    status: row?.Status ?? null,
    provider: row?.Provider ?? null,
    completedAt: row?.CompletedDate ?? null,
  };
}

/**
 * Starts (or resumes) signing for the member and returns where to send their browser.
 * @param {string} userId
 * @param {{ ip?: string }} [context] the member's IP, printed on the form
 * @returns {Promise<{ status: string, signingUrl: string|null }>}
 */
async function start(userId, { ip } = {}) {
  if (!env.ESIGN_ENABLED) throw conflictError('E-signing is not enabled');

  const account = await registrationRepository.findByAccountId(userId);
  if (!account) throw notFoundError('Registration not found');

  const provider = providerFor(account);
  if (!provider) throw badRequestError('E-signing is not available for this membership type yet');

  if (await esignRepository.hasCompletedSigning(userId)) return { status: ESIGN_STATUS.COMPLETED, signingUrl: null };

  // Payment -> sign: the chat only shows the sign card once the fee is paid; this is the same rule
  // where the signing (and the provider's credits) actually starts.
  if (!(await paymentRepository.hasSuccessfulPayment(userId))) {
    throw forbiddenError('Please pay the application fee before signing', { errorCode: 'PAYMENT_REQUIRED' });
  }

  const signerEmail = String(account.AccountEmail ?? '').trim();
  if (!signerEmail) throw badRequestError('An email address is needed before signing');
  // DocuSign shows this name on the signature; it must match between the envelope and every link.
  const signerName = String(account.AccountName ?? '').trim() || signerEmail;

  let latest = await esignRepository.findLatestSigning(userId);

  if (provider === ESIGN_PROVIDERS.DOCUSIGN && latest?.Provider === provider && latest.Status === ESIGN_STATUS.INITIATED && latest.ProviderRefId) {
    // An envelope is already out: ask where it stands, and if it is still open hand the member a fresh
    // one-time link to it rather than sending a second envelope.
    latest = await refresh(latest);
    if (latest.Status === ESIGN_STATUS.COMPLETED) return { status: ESIGN_STATUS.COMPLETED, signingUrl: null };
    if (latest.Status === ESIGN_STATUS.INITIATED) {
      const signingUrl = await esignProviders.docuSign.createSigningUrl({
        envelopeId: latest.ProviderRefId,
        signerEmail,
        signerName,
        clientUserId: String(userId),
        returnUrl: returnUrlFor(latest.ESignId, provider),
      });
      return { status: ESIGN_STATUS.INITIATED, signingUrl };
    }
  }

  const openFor = latest?.CreateDate ? Date.now() - new Date(latest.CreateDate).getTime() : Infinity;
  if (
    provider === ESIGN_PROVIDERS.EMSIGNER &&
    latest?.Provider === provider &&
    latest.Status === ESIGN_STATUS.INITIATED &&
    latest.SigningUrl &&
    openFor < REUSE_OPEN_SIGNING_MS
  ) {
    return { status: ESIGN_STATUS.INITIATED, signingUrl: latest.SigningUrl };
  }

  const row = await esignRepository.createSigning({ accountId: userId, provider, status: ESIGN_STATUS.INITIATED });
  const eSignId = String(row.ESignId);

  try {
    const { pdf, data } = await applicationPdfService.generate(userId, { ip, guid: crypto.randomUUID() });
    const unsignedPdfPath = await savePdf(userId, `application-${eSignId}.pdf`, pdf);

    const returnUrl = returnUrlFor(eSignId, provider);
    const name = `IPRS Application ${data.applicationNo}`;
    const documentName = `IPRS-Application-${data.applicationNo}.pdf`;
    const started =
      provider === ESIGN_PROVIDERS.DOCUSIGN
        ? await esignProviders.docuSign.initiateSigning({
            name,
            signerEmail,
            signerName,
            clientUserId: String(userId),
            returnUrl,
            documentName,
            pdf,
            anchorText: SIGNATURE_BOX.anchorText,
          })
        : await esignProviders.emSigner.initiateSigning({
            name,
            initiatorEmail: env.EMSIGNER_INITIATOR_EMAIL,
            signerEmail,
            redirectUrl: returnUrl,
            documentName,
            pdf,
            signatureBoxes: await emSignerBoxes(pdf, userId),
          });

    await esignRepository.updateSigning(eSignId, {
      ProviderRefId: started.workflowId,
      DocumentId: started.documentId,
      // Only eMudhra's link is reused later. DocuSign's is one-time, a new one is made each time, and it
      // is longer than the column holds (a DocuSign link made saving fail with P2000).
      SigningUrl: provider === ESIGN_PROVIDERS.EMSIGNER ? started.url : null,
      UnsignedPdfPath: unsignedPdfPath,
      ResponseJson: JSON.stringify(started.raw),
    });
    logger.info({ userId, eSignId, provider, workflowId: started.workflowId }, 'E-signing started');
    return { status: ESIGN_STATUS.INITIATED, signingUrl: started.url };
  } catch (err) {
    await esignRepository
      .updateSigning(eSignId, { Status: ESIGN_STATUS.FAILED, ResponseJson: JSON.stringify({ error: err.message }) })
      .catch(() => {});
    throw err;
  }
}

// Asks the provider where an INITIATED signing stands and records the answer. Only "Completed"
// downloads the signed PDF; anything the member can no longer finish becomes FAILED.
async function refresh(row) {
  if (row.Status !== ESIGN_STATUS.INITIATED || !row.ProviderRefId) return row;
  if (!Object.values(ESIGN_PROVIDERS).includes(row.Provider)) return row;
  const client = clientFor(row.Provider);

  const { status, raw } = await client.getWorkflowStatus(row.ProviderRefId);
  const normalized = String(status ?? '').trim().toLowerCase();

  if (normalized === 'completed') {
    const signed = await client.downloadSignedPdf(row.ProviderRefId);
    const signedPdfPath = await savePdf(row.AccountId, `application-${row.ESignId}-signed.pdf`, signed);
    const account = await registrationRepository.findByAccountId(row.AccountId);
    await registrationRepository.upsertDocument({
      accountId: row.AccountId,
      caption: SIGNED_APPLICATION_DOCUMENT,
      documentUrl: signedPdfPath,
      docFileName: path.basename(signedPdfPath),
      createdBy: account?.AccountName?.trim() || null,
    });
    logger.info({ accountId: String(row.AccountId), eSignId: String(row.ESignId) }, 'E-signing completed');
    const completed = await esignRepository.updateSigning(row.ESignId, {
      Status: ESIGN_STATUS.COMPLETED,
      SignedPdfPath: signedPdfPath,
      CompletedDate: new Date(),
      ResponseJson: JSON.stringify(raw),
    });
    await completeRegistration(row.AccountId);
    return completed;
  }

  if (DEAD_STATUSES.includes(normalized)) {
    return esignRepository.updateSigning(row.ESignId, { Status: ESIGN_STATUS.FAILED, ResponseJson: JSON.stringify(raw) });
  }
  return row;
}

/**
 * emSigner sent the member's browser back. `eSignId` comes from the return URL we gave it; the
 * status is always re-checked with emSigner.
 * @returns {Promise<string>} the row's status after the check (or 'UNKNOWN')
 */
async function handleProviderReturn(eSignId) {
  if (!/^\d+$/.test(String(eSignId ?? ''))) return 'UNKNOWN';
  const row = await esignRepository.findSigningById(eSignId);
  if (!row) return 'UNKNOWN';
  try {
    return (await refresh(row)).Status;
  } catch (err) {
    logger.warn({ eSignId: String(eSignId), err: err.message }, 'Could not confirm the signing on return');
    return row.Status;
  }
}

/** Where the member's signing stands - also confirms an INITIATED one with the provider. */
async function getStatus(userId) {
  const account = await registrationRepository.findByAccountId(userId);
  if (!account) throw notFoundError('Registration not found');
  const required = isRequiredFor(account);

  // A completed attempt wins over any newer, unfinished one.
  const completed = await esignRepository.findCompletedSigning(userId);
  if (completed) return toPublic(completed, required);

  let row = await esignRepository.findLatestSigning(userId);
  if (row?.Status === ESIGN_STATUS.INITIATED) {
    try {
      row = await refresh(row);
    } catch (err) {
      logger.warn({ userId, err: err.message }, 'Could not refresh the signing status');
    }
  }
  return toPublic(row, required);
}

export const esignService = { start, handleProviderReturn, getStatus, isRequired, isRequiredFor, isSigned, providerForUser };
