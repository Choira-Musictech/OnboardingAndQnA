// ==================================================================
// AI engine STUB (Week 1).
// Later milestone: connects the RAG / LLM pipeline (AI chatbot).
// For now returns a deterministic dummy response.
// ==================================================================
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

  return {
    reply: returning
      ? 'Your registration is already complete. Thank you!'
      : 'Your registration is complete. Thank you!',
  };
}
