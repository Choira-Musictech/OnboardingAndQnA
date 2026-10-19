// ==================================================================
// DocuSign eSignature REST API (v2.1) - embedded signing for NRI members (AccountRegType NI / NC).
//
// Plain fetch, like emsigner.client.js - the five calls below are all we need:
//   POST https://{authServer}/oauth/token                       JWT grant -> access token
//   POST {basePath}/v2.1/accounts/{accountId}/envelopes         PDF + one embedded signer
//   POST .../envelopes/{envelopeId}/views/recipient             -> one-time signing URL
//   GET  .../envelopes/{envelopeId}                             -> status (sent/delivered/completed/...)
//   GET  .../envelopes/{envelopeId}/documents/combined          -> the signed PDF
//
// Authentication is DocuSign's JWT grant: IPRS's integration impersonates IPRS's own DocuSign user, so
// that user has to have granted consent once (see consentUrl()). The private key never leaves this file
// and is never logged.
//
// The signer is "embedded" (clientUserId set): DocuSign sends them no email; they sign in the browser
// through the recipient view URL, which works once and only for a few minutes - so an unfinished signing
// is resumed with a fresh view (createSigningUrl), never by reusing an old URL.
// ==================================================================
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { appError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';

const TOKEN_LIFETIME_SECONDS = 3600;
// Ask for a new token this long before the current one runs out.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const SCOPES = 'signature impersonation';
// Our signature box carries this text (templates/applicationForm.js, SIGNATURE_BOX.anchorText).
const DEFAULT_ANCHOR = 'sign_here';

function providerError(message, details, statusCode = 502) {
  return appError(message, { statusCode, errorCode: 'ESIGN_PROVIDER_ERROR', details });
}

function notConfiguredError(message = 'E-signing is not configured') {
  return appError(message, { statusCode: 503, errorCode: 'ESIGN_NOT_CONFIGURED' });
}

export class DocuSignClient {
  #integrationKey;
  #userId;
  #accountId;
  #authServer;
  #basePath;
  #privateKeyPath;
  #privateKey;
  #timeoutMs;
  #fetch;
  #token = null;

  constructor({
    integrationKey = env.DOCUSIGN_INTEGRATION_KEY,
    userId = env.DOCUSIGN_USER_ID,
    accountId = env.DOCUSIGN_ACCOUNT_ID,
    authServer = env.DOCUSIGN_AUTH_SERVER,
    basePath = env.DOCUSIGN_BASE_PATH,
    privateKeyPath = env.DOCUSIGN_PRIVATE_KEY_PATH,
    privateKey = null,
    timeoutMs = env.DOCUSIGN_REQUEST_TIMEOUT_MS,
    fetchImpl = (...args) => fetch(...args),
  } = {}) {
    this.#integrationKey = integrationKey;
    this.#userId = userId;
    this.#accountId = accountId;
    this.#authServer = String(authServer ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.#basePath = String(basePath ?? '').replace(/\/+$/, '');
    this.#privateKeyPath = privateKeyPath;
    this.#privateKey = privateKey;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  get isConfigured() {
    return Boolean(
      this.#integrationKey && this.#userId && this.#accountId && this.#basePath && (this.#privateKey || this.#privateKeyPath),
    );
  }

  /** The page IPRS's DocuSign user opens once to let this integration act for them. */
  consentUrl(redirectUri = 'https://www.docusign.com') {
    const url = new URL(`https://${this.#authServer}/oauth/auth`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('client_id', this.#integrationKey ?? '');
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  }

  #readPrivateKey() {
    if (!this.#privateKey) {
      try {
        this.#privateKey = fs.readFileSync(this.#privateKeyPath, 'utf8');
      } catch (err) {
        logger.warn({ err: err.code ?? err.message }, 'Could not read the DocuSign private key');
        throw notConfiguredError();
      }
    }
    return this.#privateKey;
  }

  async #request(url, { method = 'GET', headers = {}, body, label }) {
    let response;
    try {
      response = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (err) {
      logger.warn({ call: label, err: err.message }, 'DocuSign request failed');
      throw providerError('The signing service could not be reached', { call: label });
    }
    return response;
  }

  async #accessToken() {
    if (this.#token && this.#token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return this.#token.value;
    if (!this.isConfigured) throw notConfiguredError();

    const assertion = jwt.sign(
      { iss: this.#integrationKey, sub: this.#userId, aud: this.#authServer, scope: SCOPES },
      this.#readPrivateKey(),
      { algorithm: 'RS256', expiresIn: TOKEN_LIFETIME_SECONDS },
    );
    const response = await this.#request(`https://${this.#authServer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      label: 'token',
    });
    const json = await response.json().catch(() => null);

    if (!response.ok || !json?.access_token) {
      const error = json?.error ?? null;
      if (error === 'consent_required') {
        // Only IPRS's DocuSign user can fix this, once, by opening the consent page.
        logger.error({ consentUrl: this.consentUrl() }, 'DocuSign needs one-time consent for this integration');
        throw notConfiguredError('E-signing is not set up yet (DocuSign consent is missing)');
      }
      logger.warn({ status: response.status, error }, 'DocuSign refused the token request');
      throw providerError('The signing service refused our credentials', { status: response.status, error });
    }

    const lifetime = Number(json.expires_in) > 0 ? Number(json.expires_in) : TOKEN_LIFETIME_SECONDS;
    this.#token = { value: json.access_token, expiresAt: Date.now() + lifetime * 1000 };
    return this.#token.value;
  }

  #accountUrl(path) {
    return `${this.#basePath}/v2.1/accounts/${this.#accountId}${path}`;
  }

  // An authorized call to the eSignature API. A rejected token is dropped so the next call asks again.
  async #api(path, { method = 'GET', body, expect = 'json', label }) {
    const headers = { Authorization: `Bearer ${await this.#accessToken()}`, Accept: expect === 'pdf' ? 'application/pdf' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.#request(this.#accountUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      label,
    });
    if (response.status === 401) this.#token = null;

    if (!response.ok) {
      const json = await response.json().catch(() => null);
      const details = { call: label, status: response.status, errorCode: json?.errorCode ?? null, message: json?.message ?? null };
      logger.warn(details, 'DocuSign returned an error response');
      throw providerError('The signing service returned an error', details);
    }
    if (expect === 'pdf') return Buffer.from(await response.arrayBuffer());
    const json = await response.json().catch(() => null);
    if (!json) throw providerError('The signing service returned an unreadable response', { call: label });
    return json;
  }

  /**
   * The member's one-time signing URL for an envelope. Called right after the envelope is made, and
   * again whenever they come back to an unfinished one.
   * @param {{ envelopeId: string, signerEmail: string, signerName: string, clientUserId: string,
   *   returnUrl: string }} input - the same email / name / clientUserId the envelope was made with
   * @returns {Promise<string>}
   */
  async createSigningUrl({ envelopeId, signerEmail, signerName, clientUserId, returnUrl }) {
    const json = await this.#api(`/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`, {
      method: 'POST',
      body: {
        returnUrl,
        authenticationMethod: 'none',
        email: signerEmail,
        userName: signerName,
        clientUserId: String(clientUserId),
      },
      label: 'recipient-view',
    });
    if (!json.url) throw providerError('The signing service did not return a signing link', { call: 'recipient-view' });
    return json.url;
  }

  /**
   * Sends the PDF for embedded signing by one signer and returns where to send their browser.
   * Same result shape as EmSignerClient.initiateSigning, so esign.service stores either one alike.
   * @param {{ name: string, signerEmail: string, signerName: string, clientUserId: string,
   *   returnUrl: string, documentName: string, pdf: Buffer, anchorText?: string }} input
   * @returns {Promise<{ workflowId: string, documentId: string, url: string, raw: object }>}
   */
  async initiateSigning({ name, signerEmail, signerName, clientUserId, returnUrl, documentName, pdf, anchorText = DEFAULT_ANCHOR }) {
    const envelope = await this.#api('/envelopes', {
      method: 'POST',
      body: {
        emailSubject: String(name).slice(0, 100),
        status: 'sent',
        documents: [{ documentId: '1', name: documentName, fileExtension: 'pdf', documentBase64: pdf.toString('base64') }],
        recipients: {
          signers: [
            {
              recipientId: '1',
              routingOrder: '1',
              email: signerEmail,
              name: signerName,
              clientUserId: String(clientUserId),
              tabs: {
                // The anchor text sits in the top-left of our signature box; the tab is dropped on it.
                signHereTabs: [{ anchorString: anchorText, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', anchorIgnoreIfNotPresent: 'false' }],
              },
            },
          ],
        },
      },
      label: 'create-envelope',
    });
    if (!envelope.envelopeId) throw providerError('The signing service did not create the envelope', { call: 'create-envelope' });

    const url = await this.createSigningUrl({ envelopeId: envelope.envelopeId, signerEmail, signerName, clientUserId, returnUrl });
    return { workflowId: String(envelope.envelopeId), documentId: '1', url, raw: envelope };
  }

  /** @returns {Promise<{ status: string|null, raw: object }>} status is DocuSign's envelope status */
  async getWorkflowStatus(envelopeId) {
    const json = await this.#api(`/envelopes/${encodeURIComponent(envelopeId)}`, { label: 'envelope-status' });
    return {
      status: json.status ?? null,
      raw: { envelopeId: json.envelopeId, status: json.status, completedDateTime: json.completedDateTime ?? null, voidedReason: json.voidedReason ?? null },
    };
  }

  /** @returns {Promise<Buffer>} the signed PDF of a completed envelope */
  async downloadSignedPdf(envelopeId) {
    const pdf = await this.#api(`/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`, { expect: 'pdf', label: 'download' });
    if (!pdf.length) throw providerError('The signing service did not return the signed document', { call: 'download' });
    return pdf;
  }
}

export const docuSignClient = new DocuSignClient();
