// ==================================================================
// The emails sent when a registration completes: a notice to IPRS's
// membership desk, the same notice to the verification team of the member's
// book (App_BookMaster.EmailId), and a confirmation to the member.
//
// Called by complete() only for the call that actually moved the account into
// the completed state, so each member gets exactly one set. Never rejects - a
// mail failure is logged and must not affect the completion it follows.
// ==================================================================
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { sendEmail } from '../../../utils/email.js';
import { registrationRepository } from '../repositories/registration.repository.js';
import { listRoleLabels } from './memberRoleCodes.js';
import { buildIprsRegistrationNotice, buildMemberApplicationReceived } from '../email-templates/registrationComplete.template.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// App_BookMaster.EmailId is one field holding several addresses separated by commas (a semicolon
// is tolerated too). Blank parts and anything that isn't an address are dropped, and each address
// is kept once regardless of case.
export function parseEmailList(value) {
  const seen = new Set();
  const emails = [];
  for (const part of String(value ?? '').split(/[,;]/)) {
    const email = part.trim();
    const key = email.toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

export function createRegistrationEmailService({ mailer, findBook, iprsEmail }) {
  async function send(accountId, kind, to, template) {
    try {
      await mailer({ to, subject: template.subject, text: template.text, html: template.html });
    } catch (err) {
      logger.error({ accountId, kind, to, err }, 'Could not send the registration-complete email');
    }
  }

  async function sendCompletionEmails(account) {
    const accountId = String(account.AccountId);
    try {
      const book = await findBook(account.BookId);
      const notice = buildIprsRegistrationNotice({
        name: account.AccountName,
        code: account.AccountCode?.toUpperCase(),
        role: listRoleLabels(account.RollTypeIds).join(', '),
        bookName: book?.BookName ?? null,
      });

      const desk = iprsEmail?.trim();
      if (desk) {
        await send(accountId, 'iprs', desk, notice);
      } else {
        logger.warn({ accountId }, 'IPRS_MEMBERSHIP_EMAIL is not set - skipping the IPRS registration notice');
      }

      // One mail per address, so a bad address can't stop the rest; the desk never gets it twice.
      const team = parseEmailList(book?.EmailId).filter((email) => email.toLowerCase() !== desk?.toLowerCase());
      if (team.length === 0) {
        logger.info({ accountId, bookId: account.BookId?.toString() ?? null }, 'No verification-team emails for this book');
      }
      for (const email of team) {
        await send(accountId, 'verification', email, notice);
      }

      if (account.AccountEmail?.trim()) {
        await send(accountId, 'member', account.AccountEmail.trim(), buildMemberApplicationReceived({ name: account.AccountName }));
      }
    } catch (err) {
      logger.error({ accountId, err }, 'Could not prepare the registration-complete emails');
    }
  }

  return { sendCompletionEmails };
}

export const registrationEmailService = createRegistrationEmailService({
  mailer: sendEmail,
  findBook: (bookId) => registrationRepository.findBook(bookId),
  iprsEmail: env.IPRS_MEMBERSHIP_EMAIL,
});
