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

  // A fresh login landing on an already-completed registration gets the payment.service.js
  // "thank you for the payment" message if it hasn't been shown yet (registrationCompleteText() is
  // guarded to fire once per account, so a payment-status poll and the chat reload after paying
  // never produce two copies). Every later login gets a welcome back instead.
  if (returning) {
    const text = paymentService.registrationCompleteText(input.userId);
    if (text) return { reply: text };
    return { reply: paymentService.welcomeBackText(input.userId) };
  }

  return { reply: 'Your registration is complete. Thank you!' };
}
