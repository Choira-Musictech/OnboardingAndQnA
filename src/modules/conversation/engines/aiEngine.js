// ==================================================================
// AI engine STUB (Week 1).
// Later milestone: connects the RAG / LLM pipeline (AI chatbot).
// For now returns a deterministic dummy response.
// ==================================================================
import { paymentService } from '../../payment/services/payment.service.js';

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

  // A fresh login landing on an already-completed registration gets the same "you're done" card
  // payment.service.js shows right after payment - Application Number and the IPRS Email ID - but
  // only if the member hasn't already been shown it (registrationCompleteText() is guarded to fire
  // once per account, so a payment-status poll and a relogin landing in the same page view, or a
  // member logging back in again later, never produce two copies of the card).
  if (returning) {
    const text = paymentService.registrationCompleteText(input.userId);
    if (text) return { reply: text };
  }

  return { reply: 'Your registration is complete. Thank you!' };
}
