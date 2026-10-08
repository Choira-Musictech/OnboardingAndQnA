// ==================================================================
// The two emails sent when a registration completes: a notice to IPRS's
// membership desk, and a confirmation to the member.
//
// Called by complete() only for the call that actually moved the account into
// the completed state, so each member gets exactly one pair. Never rejects - a
// mail failure is logged and must not affect the completion it follows.
// ==================================================================
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { sendEmail } from '../../../utils/email.js';
import { registrationRepository } from '../repositories/registration.repository.js';
import { listRoleLabels } from './memberRoleCodes.js';
import { buildIprsRegistrationNotice, buildMemberApplicationReceived } from '../email-templates/registrationComplete.template.js';

export function createRegistrationEmailService({ mailer, findBookName, iprsEmail }) {
  async function send(accountId, kind, to, template) {
    try {
      await mailer({ to, subject: template.subject, text: template.text, html: template.html });
    } catch (err) {
      logger.error({ accountId, kind, err }, 'Could not send the registration-complete email');
    }
  }

  async function sendCompletionEmails(account) {
    const accountId = String(account.AccountId);
    try {
      const notice = buildIprsRegistrationNotice({
        name: account.AccountName,
        code: account.AccountCode?.toUpperCase(),
        role: listRoleLabels(account.RollTypeIds).join(', '),
        bookName: await findBookName(account.BookId),
      });

      if (iprsEmail?.trim()) {
        await send(accountId, 'iprs', iprsEmail.trim(), notice);
      } else {
        logger.warn({ accountId }, 'IPRS_MEMBERSHIP_EMAIL is not set - skipping the IPRS registration notice');
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
  findBookName: (bookId) => registrationRepository.findBookName(bookId),
  iprsEmail: env.IPRS_MEMBERSHIP_EMAIL,
});
