// ==================================================================
// Where chat uploads are kept now that Typebot (and its S3 bucket) is gone: on this server's disk,
// under UPLOAD_DIR/<token>/<file name>, served back at
//   ${DOCUMENT_LINK_BASE_URL}/uploads/<token>/<file name>
//
// The token is 128 random bits, so the link is the credential - the same exposure as Typebot's public
// S3 links that sat in App_Accounts_Doc before. The URL keeps the shape everything downstream relies
// on: an absolute link that ends in the file name (DocFileName, the frontend's file chip) and that the
// OCR service (ocr.choira.io) can download on a public deployment.
// ==================================================================
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { env } from '../../../../config/env.js';
import { appError } from '../../../../shared/errors.js';

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
// Internal handle passed from generateUploadUrl() to uploadToPresignedUrl(), never shown to anyone.
const LOCAL_SCHEME = 'local-upload:';

export const UPLOAD_ROUTE = '/uploads';

// Only characters that are safe in a path segment and a URL; anything else becomes "_".
export function storedFileName(name) {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  const cleaned = base.slice(-120) || 'file';
  return cleaned;
}

function baseUrl(cfg) {
  return String(cfg.DOCUMENT_LINK_BASE_URL ?? '').replace(/\/+$/, '');
}

export function createUploadStorage({ cfg = env } = {}) {
  const root = () => path.resolve(cfg.UPLOAD_DIR);

  /** The file on disk for a token + name, or null when either is not one we could have issued. */
  function pathFor(token, fileName) {
    if (!TOKEN_PATTERN.test(String(token ?? ''))) return null;
    const name = String(fileName ?? '');
    if (!name || name !== storedFileName(name)) return null;
    const full = path.resolve(root(), token, name);
    // Belt and braces: the resolved path must stay inside UPLOAD_DIR.
    if (!full.startsWith(root() + path.sep)) return null;
    return full;
  }

  /** Reserves a stored name for an upload and returns where it will be served. */
  function reserve({ fileName }) {
    const token = crypto.randomBytes(16).toString('hex');
    const name = storedFileName(fileName);
    return {
      presignedUrl: `${LOCAL_SCHEME}${token}/${name}`,
      formData: {},
      fileUrl: `${baseUrl(cfg)}${UPLOAD_ROUTE}/${token}/${name}`,
    };
  }

  /** Writes the bytes for a name reserve() handed out. */
  async function save({ presignedUrl, fileBuffer }) {
    const handle = String(presignedUrl ?? '');
    const [token, name] = handle.startsWith(LOCAL_SCHEME) ? handle.slice(LOCAL_SCHEME.length).split('/') : [];
    const target = pathFor(token, name);
    if (!target) throw appError('File upload to storage failed', { errorCode: 'UPLOAD_FAILED' });
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, fileBuffer);
    } catch (cause) {
      throw appError('File upload to storage failed', { errorCode: 'UPLOAD_FAILED', cause });
    }
  }

  /** The local file behind one of our own upload links, or null for any other URL. */
  function localPathForUrl(url) {
    const prefix = `${baseUrl(cfg)}${UPLOAD_ROUTE}/`;
    const value = String(url ?? '');
    if (!baseUrl(cfg) || !value.startsWith(prefix)) return null;
    const [token, name, ...rest] = value.slice(prefix.length).split(/[?#]/)[0].split('/');
    if (rest.length) return null;
    return pathFor(token, decodeURIComponent(name ?? ''));
  }

  /** Opens a stored file for streaming, or null when there is no such file. */
  async function open(token, fileName) {
    const full = pathFor(token, fileName);
    if (!full) return null;
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) return null;
      return { size: stat.size, stream: () => createReadStream(full), path: full };
    } catch {
      return null;
    }
  }

  return { reserve, save, localPathForUrl, open, pathFor };
}

export const uploadStorage = createUploadStorage();
