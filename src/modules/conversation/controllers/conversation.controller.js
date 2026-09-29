// ==================================================================
// Conversation controller - thin.
// ==================================================================
import { ok } from '../../../shared/response.js';
import { badRequestError } from '../../../shared/errors.js';
import { conversationRouter } from '../services/conversation.router.js';
import * as registrationEngine from '../engines/registrationEngine.js';
import { translationService } from '../../translation/translation.service.js';

// The member picks a language on the first screen; the frontend sends that code on every
// request. Translating here rather than inside the engines keeps one place to change, and
// means the engines keep working in English - answers, variables and journal rows are all
// still stored in the flow's own language.
const languageOf = (req) => req.headers['x-language'];

export const sendMessage = async (req, res, next) => {
  try {
    const data = await conversationRouter.route({
      userId: req.user.id,
      token: req.token,
      // Sent in the member's language; the flow only knows its own wording.
      message: translationService.toSourceText(req.body.message, languageOf(req)),
      attachedFileUrls: req.body.attachedFileUrls,
    });
    return ok(res, { data: await translationService.translateConversationPayload(data, languageOf(req)) });
  } catch (err) {
    return next(err);
  }
};

// File uploads only ever happen mid-registration (the AI engine has no
// file-input concept), so this goes straight to registrationEngine
// rather than through the generic status-based router.
export const uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) throw badRequestError('No file uploaded');

    const data = await registrationEngine.handleUpload({
      userId: req.user.id,
      token: req.token,
      file: req.file,
    });
    return ok(res, { data: await translationService.translateConversationPayload(data, languageOf(req)) });
  } catch (err) {
    return next(err);
  }
};
