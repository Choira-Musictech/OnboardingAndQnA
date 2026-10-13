// ==================================================================
// Where the document sits in a photograph of it.
//
// The reading service already has OpenCV loaded for its own work, so the
// detection runs there rather than in the browser - an in-browser build of
// OpenCV is several megabytes, on a page people reach over mobile data to
// photograph a PAN card.
//
// This is a convenience, never a requirement: every failure answers
// { detected: false } so the upload carries on with whatever crop box it had.
// An upload must not fail because the service that suggests a crop was busy.
// ==================================================================
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';

export async function detectEdges(imageBase64) {
  if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return { detected: false, reason: 'no_image' };
  }

  try {
    const response = await fetch(`${env.OCR_API_BASE_URL}/api/detect-edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: imageBase64 }),
      signal: AbortSignal.timeout(env.OCR_REQUEST_TIMEOUT_MS),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.status) {
      return { detected: false, reason: 'service_declined' };
    }
    return body.detected
      ? { detected: true, quad: body.quad, rect: body.rect, areaFraction: body.areaFraction }
      : { detected: false };
  } catch (err) {
    logger.warn({ err: err.message }, 'Edge detection unavailable, leaving the crop box as it was');
    return { detected: false, reason: 'unreachable' };
  }
}
