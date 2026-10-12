// ==================================================================
// HTTP OCR provider - calls the real ocr.choira.io document
// verification service (see Document Verification API.postman_collection.json).
// One endpoint per doc type, all shaped { documentUrl } -> { data }.
// This service's transport contract has flip-flopped between JSON and
// multipart more than once during development - always re-probe live
// (curl) before trusting this comment if OCR starts failing again.
// Currently confirmed live (see AGENTS.md): JSON { documentUrl } is
// accepted; a multipart upload is explicitly rejected with
// 415 UPLOAD_NOT_SUPPORTED.
// Any failure (4xx from the service, non-2xx, network/timeout) is
// surfaced as a single OCR_EXTRACTION_FAILED error - the caller decides
// what "failed extraction" means for persistence (see registration.service.js).
// ==================================================================
import { appError } from '../../../../shared/errors.js';
import { env } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';

const DOC_TYPE_PATHS = {
  PAN: 'pan',
  AADHAAR: 'aadhaar',
  BANK: 'bank',
  DRIVING_LICENCE: 'driving-licence',
  VOTER_ID: 'voter-id',
  ELECTRICITY: 'electricity',
  PASSPORT: 'passport',
  GST: 'gst',
};

// Confirmed with the OCR team (not in the service's own Postman collection) - DRIVING_LICENCE/
// PASSPORT/VOTER_ID/BANK accept an optional `name` field so the service can verify the document's
// name against it. GST was never documented for this but was live-probed this session and behaves
// identically: sending `name` gets a real government-registry name check back, matching returns 201,
// a mismatch returns 422 with code NAME_MISMATCH and the service's own message - exactly the same
// contract, so it's included here too, and this app has no cross-document name check of its own
// anymore (relies entirely on the OCR service for this). BANK covers both passbook and cheque - this
// app has a single BANK doc type/OCR endpoint for both. Deliberately NOT every doc type -
// AADHAAR/ELECTRICITY keep sending only { documentUrl }, user-confirmed scope. Gated by
// env.OCR_NAME_VERIFICATION_ENABLED (see config/env.js) - a
// blanket kill-switch, same shape as OCR_ENABLED, for when this check blocks testing.
const NAME_VERIFIED_DOC_TYPES = new Set(['DRIVING_LICENCE', 'PASSPORT', 'VOTER_ID', 'BANK', 'GST']);

// Which cross-check fields the registry disagreed with. The service reports
// these per field as match/mismatch/null inside the verification block; the
// message only names the ones that actually disagreed.
function mismatchedFields(body) {
  const cross = body?.data?.verification?.crossCheck;
  if (!cross || typeof cross !== 'object') return null;
  const fields = Object.entries(cross)
    .filter(([key, value]) => value === 'mismatch' && key !== 'allMatch')
    .map(([key]) => key);
  return fields.length ? fields : null;
}

// What the translator needs to rebuild this refusal in the member's language.
// Carried alongside the service's own English, which stays for the logs and for
// English members. Null when the service sent no code - there is nothing to
// rebuild from, and the English is then all we have.
function ocrFailureContext(body, docType) {
  if (!body?.code) return null;
  return {
    code: body.code,
    expectedDocument: body.expectedDocument ?? docType,
    detectedDocument: body.detectedDocument ?? null,
    expectedHolderType: body.expectedHolderType ?? null,
    detectedHolderType: body.detectedHolderType ?? null,
    fields: mismatchedFields(body),
    limit: body.limit ?? null,
  };
}

export function createHttpOcrProvider() {
  // panHolderType: confirmed with the OCR team (not in the service's own Postman collection) - the
  // `pan` endpoint accepts an optional `type` field, "p" for a person's PAN, "c" for a company's,
  // so it knows which holder type to expect from the card image. Only meaningful for docType=PAN -
  // ignored (and omitted from the request body) for every other doc type.
  async function extract({ docType, documentUrl, panHolderType, holderName, registrationId }) {
    const path = DOC_TYPE_PATHS[docType];
    if (!path) {
      throw appError(`No OCR endpoint for docType=${docType}`, {
        statusCode: 400,
        errorCode: 'OCR_UNSUPPORTED_DOC_TYPE',
      });
    }

    const requestBody = { documentUrl };
    if (docType === 'PAN' && (panHolderType === 'p' || panHolderType === 'c')) {
      requestBody.type = panHolderType;
    }
    if (env.OCR_NAME_VERIFICATION_ENABLED && NAME_VERIFIED_DOC_TYPES.has(docType)) {
      requestBody.name = holderName || '';
    }

    // One line per call, success or not, so whether OCR ran - and how long it took - can be read
    // from the log instead of being inferred from the database afterwards.
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(`${env.OCR_API_BASE_URL}/api/documents/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(env.OCR_REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      logger.warn(
        { registrationId, docType, durationMs: Date.now() - startedAt, reason: cause?.cause?.code ?? cause?.name, message: cause?.message },
        'OCR call failed - service unreachable',
      );
      throw appError('OCR service unreachable', { errorCode: 'OCR_EXTRACTION_FAILED', details: { stage: 'ocr_call' }, cause });
    }

    const body = await response.json().catch(() => null);

    // body.success only means the API call itself didn't error - it stays true even when the
    // document failed real verification (e.g. VERIFICATION_UNAVAILABLE). body.status is the one
    // that reflects whether OCR/verification actually succeeded, so that's the field that decides
    // failure here.
    if (!response.ok || !body?.status) {
      logger.warn(
        { registrationId, docType, status: response.status, durationMs: Date.now() - startedAt, code: body?.code, message: body?.message },
        'OCR call rejected the document',
      );
      throw appError(body?.message ?? `OCR request failed with status ${response.status}`, {
        statusCode: response.status,
        errorCode: 'OCR_EXTRACTION_FAILED',
        details: { stage: 'ocr_call', ...body, ocr: ocrFailureContext(body, docType) },
      });
    }

    logger.info({ registrationId, docType, status: response.status, durationMs: Date.now() - startedAt }, 'OCR call succeeded');
    return body.data;
  }

  return { extract };
}
