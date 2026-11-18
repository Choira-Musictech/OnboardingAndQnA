// ==================================================================
// Streams one chat upload from disk. Thin: uploadStorage.js decides what exists.
// ==================================================================
import path from 'node:path';
import { uploadStorage } from '../../conversation/services/flow/uploadStorage.js';
import { notFoundError } from '../../../shared/errors.js';
import { logger } from '../../../utils/logger.js';

// What a member uploads and a browser can render inline; anything else is served as a download.
const INLINE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

export async function serveUpload(req, res, next) {
  const { token, fileName } = req.params;
  const file = await uploadStorage.open(token, fileName);
  if (!file) return next(notFoundError('File not found'));

  const contentType = INLINE_TYPES[path.extname(fileName).toLowerCase()];
  res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  // helmet sets same-origin for the whole app, which would stop the chat (another host) from showing it.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${contentType ? 'inline' : 'attachment'}; filename="${fileName}"`);

  const stream = file.stream();
  stream.on('error', (err) => {
    logger.warn({ token, err: err.message }, 'Upload stream failed mid-transfer');
    res.destroy(err);
  });
  stream.pipe(res);
}
