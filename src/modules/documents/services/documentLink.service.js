// ==================================================================
// Signed links that serve a member's uploaded documents from this API.
//
// A resumed chat has no File object left - only the URL the document was
// uploaded to. Typebot's S3 bucket answers a plain GET, but sends no
// Access-Control-Allow-Origin, so pdf.js cannot read those bytes: a resumed
// PDF card has no thumbnail, and on a phone its preview falls back to
// "The PDF could not be rendered". Read back through this API the same bytes
// are readable, because this app already answers the chat origin with CORS.
//
// <img src>, <object data> and pdf.js cannot send an Authorization header, so
// the link carries its own capability instead: an expiring HMAC over the
// document id, minted only while rebuilding a transcript for the member who
// owns the document.
// ==================================================================
import crypto from 'node:crypto';
import { env } from '../../../config/env.js';

// Signed with JWT_SECRET, so a link is exactly as trustworthy as a session
// token and rotating the secret invalidates every link still in flight.
function signatureFor(docId, expiresAt) {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`document:${docId}:${expiresAt}`)
    .digest('base64url');
}

/**
 * The name the chat will show, and read the file type from.
 *
 * FileMessageCard decides image-vs-PDF from the extension alone (no mime type
 * survives a resume), so the real name has to reach the link or the document
 * comes back as a bare file icon. The uploaded URL's own last segment is
 * preferred because that is what the member recognises: DocFileName holds the
 * same name behind an internal prefix (MRU_158181_3_N1_Vivartpassport.pdf).
 */
export function fileNameFor(doc) {
  const fromUrl = String(doc?.DocumentCaption ?? '').split('?')[0].split('/').pop() ?? '';
  let decoded = fromUrl;
  try {
    decoded = decodeURIComponent(fromUrl);
  } catch {
    // A caption with a stray % is not a reason to lose the name.
  }
  if (decoded.includes('.')) return decoded;
  const stored = String(doc?.DocFileName ?? '').trim();
  return stored || decoded || 'document';
}

export function buildDocumentUrl(doc, { now = Date.now() } = {}) {
  if (doc?.AccountDocId == null) return null;
  if (!isFetchableDocumentUrl(doc.DocumentCaption)) return null;
  const docId = String(doc.AccountDocId);
  const expiresAt = now + env.DOCUMENT_LINK_TTL_HOURS * 60 * 60 * 1000;
  const base = env.DOCUMENT_LINK_BASE_URL.replace(/\/+$/, '');
  const name = encodeURIComponent(fileNameFor(doc));
  return `${base}/documents/${docId}/${name}?e=${expiresAt}&t=${signatureFor(docId, expiresAt)}`;
}

export function verifyDocumentLink({ docId, expiresAt, token }) {
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  const expected = Buffer.from(signatureFor(String(docId), expiry));
  const given = Buffer.from(String(token ?? ''));
  // timingSafeEqual throws on a length mismatch, so check that first.
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Only the hosts documents are uploaded to.
 *
 * A caption is written by this app, but it is still a stored string being
 * turned into an outbound request, and this table also holds legacy rows from
 * the old portal whose caption is a bare numeric id rather than a URL. An
 * allowlist keeps both away from anything else on the network.
 */
export function isFetchableDocumentUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const allowed = env.DOCUMENT_LINK_ALLOWED_HOSTS.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(url.hostname.toLowerCase());
}
