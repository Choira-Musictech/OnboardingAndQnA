import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { appError } from '../shared/errors.js';

let transport;

function getTransport() {
  if (transport) return transport;

  const opts = createSmtpOptions();

  transport = nodemailer.createTransport(opts);

  // Verify connection configuration lazily (don't throw at import time)
  transport.verify((err, success) => {
    if (err) {
      // Never log the password: the options carry it, and the log now also goes to a file.
      const safeOpts = { ...opts, auth: opts.auth ? { user: opts.auth.user } : undefined };
      logger.warn({ err: err.message, opts: safeOpts }, 'SMTP verify failed');
    } else {
      logger.debug('SMTP transporter verified');
    }
  });

  return transport;
}

export async function sendEmail({ to, subject, text, html, from }) {
  const t = getTransport();
  try {
    const info = await t.sendMail({ from: from ?? env.SMTP_FROM ?? env.SMTP_USER, to, subject, text, html });
    logger.debug({ to, subject, msgId: info.messageId }, 'Email sent');
    return info;
  } catch (err) {
    // Log safe details; include stack in dev only
    logger.error({ err: err.message, to }, 'Failed to send email');
    const details = { message: err.message };
    if (!env.isProd) details.stack = err.stack;
    throw appError('Failed to send email', { details });
  }
}

export function createSmtpOptions() {
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT),
    // 465 = implicit TLS (secure true); 587 = STARTTLS (secure false + requireTLS)
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    requireTLS: !env.SMTP_SECURE,
    tls: { rejectUnauthorized: env.isProd },
    connectionTimeout: 30_000,
  };
}
