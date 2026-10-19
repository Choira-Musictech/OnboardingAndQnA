// ==================================================================
// Serves one uploaded document by signed link, streamed from wherever it was
// uploaded. See documentLink.service.js for why the chat cannot read the
// uploader's bucket directly, and why the link - not a bearer token - is the
// credential here.
// ==================================================================
import { Readable } from 'node:stream';
import { registrationRepository } from '../../registration/repositories/registration.repository.js';
import {
  fileNameFor,
  isFetchableDocumentUrl,
  verifyDocumentLink,
} from '../services/documentLink.service.js';
import { appError, notFoundError, unauthorizedError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';

// What a member actually uploads, and what a browser can render inline.
// Anything else is still served, but as a download rather than as a document
// the page is invited to interpret.
const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const UPSTREAM_TIMEOUT_MS = 20000;

// Quoted in Content-Disposition, so anything that could close the quote or the
// header has to go. The UTF-8 copy in filename* carries the real name.
function asciiFileName(name) {
  const cleaned = String(name).replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned || 'document';
}

export async function streamDocument(req, res, next) {
  const { accountDocId, fileName } = req.params;

  // An id that is not a plain number never names a row - and must not reach BigInt().
  if (!/^\d{1,18}$/.test(String(accountDocId))) {
    return next(notFoundError('Document not found'));
  }
  if (!verifyDocumentLink({ docId: accountDocId, expiresAt: req.query.e, token: req.query.t })) {
    return next(unauthorizedError('This document link is invalid or has expired'));
  }

  let doc;
  try {
    doc = await registrationRepository.findDocumentById(accountDocId);
  } catch (err) {
    return next(err);
  }
  if (!doc || !isFetchableDocumentUrl(doc.DocumentCaption)) {
    return next(notFoundError('Document not found'));
  }

  let upstream;
  try {
    upstream = await fetch(doc.DocumentCaption, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    logger.warn({ accountDocId, err }, 'Could not read the stored document');
    return next(appError('The document could not be read right now', {
      statusCode: 502,
      errorCode: 'DOCUMENT_UNAVAILABLE',
      cause: err,
    }));
  }
  if (!upstream.ok || !upstream.body) {
    logger.warn({ accountDocId, status: upstream.status }, 'Stored document is no longer available');
    return next(notFoundError('Document not found'));
  }

  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const inline = INLINE_TYPES.has(contentType);
  const name = fileName ? decodeURIComponent(fileName) : fileNameFor(doc);

  res.setHeader('Content-Type', inline ? contentType : 'application/octet-stream');
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  // helmet sets this to same-origin for the whole app, which would stop the
  // chat - a different host on the same site - from rendering the document at all.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${asciiFileName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );

  const body = Readable.fromWeb(upstream.body);
  body.on('error', (err) => {
    logger.warn({ accountDocId, err }, 'Document stream failed mid-transfer');
    res.destroy(err);
  });
  body.pipe(res);
}
