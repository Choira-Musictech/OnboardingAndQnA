// ==================================================================
// eMudhra emSigner Core (eBaaS) public API - Aadhaar eSign for Indian members.
//
// Contract taken from IPRS's own emSigner Postman collection (all calls POST, plain JSON):
//   /api/Public/AuthorizeApp/authorize          AppName + SecretKey -> authToken (JWT) + refreshToken
//   /api/Public/InitiateEmbeddedSigning         PDF (base64) + signer -> workflowId + signing url
//   /api/Public/GetWorkflowInfo/GetDocumentInfo workflowId -> workflowStatus (Pending/Completed/...)
//   /api/Public/DownloadWorkFlowDocumentByWorkflowId/download-documents
//                                               workflowid -> signed PDF (base64)
// Every workflow call needs `Authorization: Bearer <authToken>` and an `Environment` header.
// Responses share one envelope: { isSuccess, messages, errorCode, errorKey, response }.
//
// The secret key never leaves this file and is never logged.
// ==================================================================
import { env } from '../../../config/env.js';
import { appError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';

// emSigner's own signature modes; 12 is Aadhaar OTP eSign.
export const MODE_OF_SIGNATURE_AADHAAR = '12';

// Re-authorize this long before the token's own expiry, so a call never starts with a token that
// runs out mid-request.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
// When the token carries no readable expiry, keep it this long.
const FALLBACK_TOKEN_TTL_MS = 10 * 60_000;

function tokenExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // not a readable JWT - fall back below
  }
  return Date.now() + FALLBACK_TOKEN_TTL_MS;
}

// emSigner does not read ControlDetails as left/top/width/height. Seen on a real UAT signing: the
// four numbers become the signature's PDF rectangle as two corners, in points from the page's
// BOTTOM-left - (left, top) is one corner and (width, height) the other. (Sent 397/425/164/62, got
// /Rect [164 62 397 425].) So a box measured from the page's top-left is converted to its corners.
export function toEmSignerControl({ left, top, width, height, pageHeight }) {
  const upperY = Math.round(pageHeight - top);
  return { left: Math.round(left), top: upperY, width: Math.round(left + width), height: Math.round(upperY - height) };
}

function providerError(message, details, statusCode = 502) {
  return appError(message, { statusCode, errorCode: 'ESIGN_PROVIDER_ERROR', details });
}

export class EmSignerClient {
  #baseUrl;
  #appName;
  #secretKey;
  #environment;
  #timeoutMs;
  #fetch;
  #token = null;

  constructor({
    baseUrl = env.EMSIGNER_BASE_URL,
    appName = env.EMSIGNER_APP_NAME,
    secretKey = env.EMSIGNER_SECRET_KEY,
    environment = env.EMSIGNER_ENVIRONMENT,
    timeoutMs = env.EMSIGNER_REQUEST_TIMEOUT_MS,
    fetchImpl = (...args) => fetch(...args),
  } = {}) {
    this.#baseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    this.#appName = appName;
    this.#secretKey = secretKey;
    this.#environment = environment;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  get isConfigured() {
    return Boolean(this.#baseUrl && this.#appName && this.#secretKey);
  }

  async #post(path, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      headers.Authorization = `Bearer ${await this.#accessToken()}`;
      headers.Environment = this.#environment;
    }

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      logger.warn({ path, err: err.message }, 'emSigner request failed');
      throw providerError('The signing service could not be reached', { path });
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      // handled below
    }

    // A rejected token is dropped so the next call authorizes again.
    if (response.status === 401) this.#token = null;

    if (!response.ok || !json) {
      logger.warn({ path, status: response.status }, 'emSigner returned an error response');
      throw providerError('The signing service returned an error', { path, status: response.status });
    }
    return json;
  }

  static #ok(json) {
    return (json.isSuccess ?? json.IsSuccess) === true;
  }

  static #describe(json) {
    return {
      errorCode: json.errorCode ?? json.ErrorCode ?? null,
      errorKey: json.errorKey ?? json.ErrorKey ?? null,
      messages: json.messages ?? json.Messages ?? [],
    };
  }

  async #accessToken() {
    if (this.#token && this.#token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return this.#token.value;
    if (!this.isConfigured) {
      throw appError('E-signing is not configured', { statusCode: 503, errorCode: 'ESIGN_NOT_CONFIGURED' });
    }

    const json = await this.#post(
      '/api/Public/AuthorizeApp/authorize',
      { AppName: this.#appName, SecretKey: this.#secretKey },
      { auth: false },
    );
    const value = json.response?.authToken;
    if (!EmSignerClient.#ok(json) || !value) {
      logger.warn(EmSignerClient.#describe(json), 'emSigner authorization was refused');
      throw providerError('The signing service refused our credentials', EmSignerClient.#describe(json));
    }
    this.#token = { value, expiresAt: tokenExpiry(value) };
    return value;
  }

  /**
   * Starts an Aadhaar eSign workflow for one signer.
   * @param {{ name: string, initiatorEmail: string, signerEmail: string, redirectUrl: string,
   *   documentName: string, pdf: Buffer, signatureBox: { page: number, left: number, top: number,
   *   width: number, height: number, pageHeight: number } }} input - the box in PDF points,
   *   measured from the page's top-left corner
   * @returns {Promise<{ workflowId: string, documentId: string|null, url: string, raw: object }>}
   */
  async initiateSigning({ name, initiatorEmail, signerEmail, redirectUrl, documentName, pdf, signatureBox }) {
    const json = await this.#post('/api/Public/InitiateEmbeddedSigning', {
      WorkflowType: 1,
      Name: name,
      RequestFrom: 'IPRS Onboarding',
      RedirectURL: redirectUrl,
      EmailId: initiatorEmail,
      SignatoryEmailIds: [signerEmail],
      SignatureSettings: [{ ModeOfSignature: MODE_OF_SIGNATURE_AADHAAR, CaptureSelfie: false, VerifyDemographicData: false }],
      lstDocumentDetails: [
        {
          DocumentName: documentName,
          FileData: pdf.toString('base64'),
          ControlDetails: [
            {
              controlID: 4,
              page: 'Specify',
              pageNo: String(signatureBox.page),
              ...toEmSignerControl(signatureBox),
              assignedTo: 1,
              SignerType: 1,
            },
          ],
        },
      ],
    });

    const result = json.response ?? {};
    if (!EmSignerClient.#ok(json) || !result.workflowId || !result.url) {
      logger.warn(EmSignerClient.#describe(json), 'emSigner did not start the signing');
      throw providerError('The signing service could not start the signing', EmSignerClient.#describe(json));
    }
    return {
      workflowId: String(result.workflowId),
      documentId: result.documentIdList?.[0] != null ? String(result.documentIdList[0]) : null,
      url: result.url,
      raw: { ...json, response: { ...result } },
    };
  }

  /** @returns {Promise<{ status: string|null, raw: object }>} status is emSigner's workflowStatus */
  async getWorkflowStatus(workflowId) {
    const json = await this.#post('/api/Public/GetWorkflowInfo/GetDocumentInfo', {
      workflowId: Number(workflowId),
      referenceNo: '',
      parentDocId: 0,
    });
    if (!EmSignerClient.#ok(json)) {
      throw providerError('The signing service could not report the signing status', EmSignerClient.#describe(json));
    }
    const result = json.response ?? json.Response ?? {};
    return { status: result.workflowStatus ?? result.WorkflowStatus ?? null, raw: json };
  }

  /** @returns {Promise<Buffer>} the signed PDF of a completed workflow */
  async downloadSignedPdf(workflowId) {
    const json = await this.#post('/api/Public/DownloadWorkFlowDocumentByWorkflowId/download-documents', {
      workflowid: Number(workflowId),
      documentId: 0,
      referenceNo: '',
      isMerged: true,
    });
    // The live API answers with response.fileList[].base64FileData (errorKey DL_DOWNLOAD_SUCCESS);
    // the Postman docs show response.fileData - both are read. isMerged:true gives one PDF.
    const result = json.response ?? json.Response ?? {};
    const document = (result.fileList ?? result.FileList ?? []).find((file) => !file.isAttachment) ?? null;
    const fileData = document?.base64FileData ?? document?.Base64FileData ?? result.fileData ?? result.FileData;
    if (!EmSignerClient.#ok(json) || !fileData) {
      throw providerError('The signing service did not return the signed document', EmSignerClient.#describe(json));
    }
    return Buffer.from(fileData, 'base64');
  }
}

export const emSignerClient = new EmSignerClient();
