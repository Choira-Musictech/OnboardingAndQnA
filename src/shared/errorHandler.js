// ==================================================================
// Central error handler (4-arg) + 404 handler. Mounted LAST in app.js.
//   - AppError subclasses (operational) -> show message/details.
//   - Zod / Prisma / JSON parse errors -> normalized to AppError.
//   - Anything else -> sanitized 500 (no stack leakage), full log.
// ==================================================================
import httpStatus from 'http-status-codes';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { appError, validationError, notFoundError, conflictError, badRequestError } from './errors.js';
import { logger } from '../utils/logger.js';
import { resolveTargetLanguage } from '../modules/translation/translation.service.js';
import { lookup } from '../modules/translation/dictionary.js';

/**
 * An operational error's message is shown to the member, not just logged: the
 * web client puts error.message straight on screen. So it is answered in their
 * language like every other message, from the same dictionary, by the same
 * rules - a message with no entry is returned exactly as it is, which is what
 * an English member gets anyway. Doing it here rather than at each throw site
 * means a message added later is covered without anyone remembering to.
 */
function inMemberLanguage(message, req) {
  if (typeof message !== 'string' || !message.trim()) return message;
  try {
    const language = resolveTargetLanguage(req?.headers?.['x-language']);
    return language ? lookup(message, language) ?? message : message;
  } catch {
    // Never let the translator turn an error response into a second error.
    return message;
  }
}

function normalizeError(err) {
  if (err instanceof ZodError) {
    return validationError('Validation failed', err.flatten().fieldErrors);
  }

  if (err instanceof multer.MulterError) {
    return badRequestError(err.message, { errorCode: 'UPLOAD_ERROR' });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return conflictError(
          `Duplicate value for unique constraint on: ${err.meta?.target ?? 'unknown'}`,
        );
      case 'P2025':
        return notFoundError('Record not found');
      case 'P2003':
      case 'P2014':
        return appError('Database integrity constraint error', {
          statusCode: httpStatus.BAD_REQUEST,
          errorCode: 'BAD_REQUEST',
        });
      default:
        return appError(`Database error (${err.code})`);
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return appError('Invalid database query', {
      statusCode: httpStatus.BAD_REQUEST,
      errorCode: 'BAD_REQUEST',
    });
  }

  // JSON body parse failures thrown by express.json()
  if (err && err.type === 'entity.parse.failed') {
    return appError('Malformed JSON body', {
      statusCode: httpStatus.BAD_REQUEST,
      errorCode: 'BAD_REQUEST',
    });
  }

  return err;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err);

  const statusCode = normalized.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
  const isOperational = normalized?.isOperational === true;
  const requestId = req.id;

  if (isOperational) {
    const body = {
      success: false,
      error: {
        code: normalized.errorCode || 'ERROR',
        message: inMemberLanguage(normalized.message || httpStatus.getStatusText(statusCode), req),
      },
    };
    if (normalized.details) body.error.details = normalized.details;

    logger.warn({ requestId, statusCode }, `Operational error: ${normalized.message}`);
    return res.status(statusCode).json(body);
  }

  // Unknown / programming error â€” never leak internals to the client
  logger.error({ requestId, err: normalized }, 'Unhandled error');
  return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: inMemberLanguage('Internal server error', req) },
  });
}

export function notFoundHandler(req, res, next) {
  next(notFoundError(`Route ${req.method} ${req.originalUrl} not found`));
}
