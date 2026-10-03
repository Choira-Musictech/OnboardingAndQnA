// ==================================================================
// AI engine STUB (Week 1).
// Later milestone: connects the RAG / LLM pipeline (AI chatbot).
// For now returns a deterministic dummy response.
// ==================================================================
import { env } from '../../../config/env.js';

/**
 * @param {{ userId: string, message: string }} input
 * @returns {Promise<{ reply: string }>}
 */
export async function handle(input) {
  // "Already" is only true for someone coming back to find it done. Said to a
  // member who has just finished, it reads as though they repeated themselves.
  //
  // A message of undefined is the session being restored - the chat asks for
  // its current state on every page load, which is what a fresh login is. A
  // real message means they are still in the session where they finished.
  const returning = input?.message === undefined;

  // A fresh login landing on an already-completed registration gets the same
  // "you're done" card payment.service.js's registrationCompleteMessage() shows right
  // after payment - Application Number (the account's own id) and the IPRS Email ID,
  // so logging back in later still tells the member what they need to quote/write to.
  if (returning) {
    const contact = env.SUPPORT_CONTACT?.trim();
    const emailLine = contact ? `\nIPRS Email ID: ${contact}` : '';
    return {
      reply:
        `Thank You for Registration!\n\n` +
        `Application Number: ${input.userId}${emailLine}\n\n` +
        `You will receive a confirmation email from the IPRS team.`,
    };
  }

  return { reply: 'Your registration is complete. Thank you!' };
}
