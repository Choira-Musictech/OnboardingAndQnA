// ==================================================================
// Service-to-service authentication for trusted channel services (e.g. the WhatsApp service).
// X-Service-Key must equal SERVICE_API_KEY; with it unset the endpoint behind this is disabled.
// ==================================================================
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { notFoundError, unauthorizedError } from '../shared/errors.js';

export function authenticateService(req, res, next) {
  if (!env.SERVICE_API_KEY) return next(notFoundError('Not found'));
  const given = Buffer.from(String(req.headers['x-service-key'] ?? ''));
  const expected = Buffer.from(env.SERVICE_API_KEY);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return next(unauthorizedError('Invalid service key'));
  }
  return next();
}
