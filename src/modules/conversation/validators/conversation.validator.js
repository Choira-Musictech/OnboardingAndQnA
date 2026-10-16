// ==================================================================
// Conversation request validators (Zod).
// ==================================================================
import { z } from 'zod';

export const sendMessageSchema = z.object({
  body: z.object({
    // Optional: the very first call (starting a Typebot session) needs no answer yet.
    message: z.string().trim().max(4000).optional(),
    attachedFileUrls: z.array(z.string().url()).optional(),
    // Sent on the empty call that follows a language switch: show the question the member is on,
    // in the new language, instead of offering to resume.
    relocalize: z.boolean().optional(),
  }),
});
