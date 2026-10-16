// ==================================================================
// E-signing of the member's application form - review -> sign -> payment.
//
// Who signs with what (IPRS's own routing): AccountRegType I / C (Indian individual / company)
// sign with eMudhra emSigner Aadhaar eSign; NI / NC (NRI) will sign with DocuSign, which is not
// built yet - until it is, NRI members are not asked to sign (isRequired() is false for them).
//
// Rules this service keeps (from IPRS's integration guide):
//   - The App_Accounts_ESign row exists BEFORE the member is sent to the provider, and the return
//     URL carries that row's id - a return is only ever matched to a row we created.
//   - A return is never trusted as proof. The provider is asked for the workflow status, and only
//     "Completed" downloads the signed PDF and marks the row COMPLETED.
//   - Payment waits for a COMPLETED row (see isSigned(), used by the chat gate and payment.service).
// ==================================================================
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env.js';
import { appError, badRequestError, conflictError, notFoundError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';
import { registrationRepository } from '../../registration/repositories/registration.repository.js';
import { REG_TYPES } from '../../registration/services/memberRoleCodes.js';
import { esignRepository } from '../repositories/esign.repository.js';
import { SIGNATURE_BOX } from '../templates/applicationForm.js';
import { applicationPdfService } from './applicationPdf.service.js';
import { SIGNED_APPLICATION_DOCUMENT } from './applicationData.service.js';
import { emSignerClient } from './emsigner.client.js';

export const ESIGN_PROVIDERS = Object.freeze({ EMSIGNER: 'EMSIGNER', DOCUSIGN: 'DOCUSIGN' });
export const ESIGN_STATUS = Object.freeze({ INITIATED: 'INITIATED', COMPLETED: 'COMPLETED', FAILED: 'FAILED' });

// emSigner workflowStatus values that mean the member can no longer sign this workflow.
const EMSIGNER_DEAD_STATUSES = ['recalled', 'expired', 'rejected', 'declined'];

// An unfinished signing link is reused for this long instead of starting a second workflow.
const REUSE_OPEN_SIGNING_MS = 30 * 60_000;

const PROVIDER_BY_REG_TYPE = Object.freeze({
  [REG_TYPES.INDIVIDUAL]: ESIGN_PROVIDERS.EMSIGNER,
  [REG_TYPES.PUBLISHER]: ESIGN_PROVIDERS.EMSIGNER,
  // NI / NC -> DOCUSIGN once that provider is built.
});

// Swappable in tests, same technique verifyGate.js's verifyProvider export uses.
export const esignProviders = { emSigner: emSignerClient };

function providerFor(account) {
  return PROVIDER_BY_REG_TYPE[String(account?.AccountRegType ?? '').trim()] ?? null;
}

/** Whether this member must sign before paying. */
function isRequiredFor(account) {
  return env.ESIGN_ENABLED && providerFor(account) !== null;
}

async function isRequired(userId) {
  return isRequiredFor(await registrationRepository.findByAccountId(userId));
}

async function isSigned(userId) {
  return esignRepository.hasCompletedSigning(userId);
}

// PDFs live under ESIGN_STORAGE_DIR/<AccountId>/; the stored path is relative to the backend folder.
async function savePdf(accountId, fileName, pdf) {
  const relative = path.join(env.ESIGN_STORAGE_DIR, String(accountId), fileName);
  const absolute = path.resolve(relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, pdf);
  return relative.split(path.sep).join('/');
}

function returnUrlFor(eSignId) {
  if (!env.EMSIGNER_RETURN_URL) {
    throw appError('E-signing return URL is not configured', { statusCode: 503, errorCode: 'ESIGN_NOT_CONFIGURED' });
  }
  const url = new URL(env.EMSIGNER_RETURN_URL);
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

  const latest = await esignRepository.findLatestSigning(userId);

  const openFor = latest?.CreateDate ? Date.now() - new Date(latest.CreateDate).getTime() : Infinity;
  if (latest?.Status === ESIGN_STATUS.INITIATED && latest.SigningUrl && openFor < REUSE_OPEN_SIGNING_MS) {
    return { status: ESIGN_STATUS.INITIATED, signingUrl: latest.SigningUrl };
  }

  const signerEmail = String(account.AccountEmail ?? '').trim();
  if (!signerEmail) throw badRequestError('An email address is needed before signing');

  const row = await esignRepository.createSigning({ accountId: userId, provider, status: ESIGN_STATUS.INITIATED });
  const eSignId = String(row.ESignId);

  try {
    const { pdf, data } = await applicationPdfService.generate(userId, { ip, guid: crypto.randomUUID() });
    const unsignedPdfPath = await savePdf(userId, `application-${eSignId}.pdf`, pdf);

    const started = await esignProviders.emSigner.initiateSigning({
      name: `IPRS Application ${data.applicationNo}`,
      initiatorEmail: env.EMSIGNER_INITIATOR_EMAIL,
      signerEmail,
      redirectUrl: returnUrlFor(eSignId),
      documentName: `IPRS-Application-${data.applicationNo}.pdf`,
      pdf,
      signatureBox: { page: SIGNATURE_BOX.page, ...SIGNATURE_BOX.pt, pageHeight: SIGNATURE_BOX.pageHeightPt },
    });

    await esignRepository.updateSigning(eSignId, {
      ProviderRefId: started.workflowId,
      DocumentId: started.documentId,
      SigningUrl: started.url,
      UnsignedPdfPath: unsignedPdfPath,
      ResponseJson: JSON.stringify(started.raw),
    });
    logger.info({ userId, eSignId, workflowId: started.workflowId }, 'E-signing started');
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
  if (row.Provider !== ESIGN_PROVIDERS.EMSIGNER) return row;

  const { status, raw } = await esignProviders.emSigner.getWorkflowStatus(row.ProviderRefId);
  const normalized = String(status ?? '').trim().toLowerCase();

  if (normalized === 'completed') {
    const signed = await esignProviders.emSigner.downloadSignedPdf(row.ProviderRefId);
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
    return esignRepository.updateSigning(row.ESignId, {
      Status: ESIGN_STATUS.COMPLETED,
      SignedPdfPath: signedPdfPath,
      CompletedDate: new Date(),
      ResponseJson: JSON.stringify(raw),
    });
  }

  if (EMSIGNER_DEAD_STATUSES.includes(normalized)) {
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

export const esignService = { start, handleProviderReturn, getStatus, isRequired, isRequiredFor, isSigned };
