// ==================================================================
// The conversation's flow client. It used to call Typebot's Chat API; the flow now runs inside this
// backend (../flow/flowEngine.js, the Typebot export in ../../flow/registrationFlow.json) and uploads
// are kept on this server (../flow/uploadStorage.js). No Typebot server is involved any more.
//
// The object and its method names are unchanged on purpose: registrationEngine.js, the journal replay
// and the tests all call (and stub) `typebotClient.x(...)`, and the responses keep Typebot's shapes
// ({ sessionId, messages, input }), so nothing above this file had to change.
// ==================================================================
import { appError } from '../../../../shared/errors.js';
import { flowEngine } from '../flow/flowEngine.js';
import { uploadStorage } from '../flow/uploadStorage.js';

async function startChat({ prefilledVariables } = {}) {
  return flowEngine.startChat({ prefilledVariables });
}

async function continueChat({ sessionId, message }) {
  return flowEngine.continueChat({ sessionId, message });
}

// Reserves where the file will be kept and the link it will be served at. `fileUrl` is what gets
// saved on the document and answered to the file question.
async function generateUploadUrl({ sessionId, fileName }) {
  if (!flowEngine.hasSession(sessionId)) {
    throw appError("Can't find session", { statusCode: 400, errorCode: 'TYPEBOT_REQUEST_FAILED' });
  }
  return uploadStorage.reserve({ fileName });
}

// Writes the bytes for a name generateUploadUrl() reserved.
async function uploadToPresignedUrl({ presignedUrl, fileBuffer }) {
  return uploadStorage.save({ presignedUrl, fileBuffer });
}

// --- Expired sessions -------------------------------------------------------
//
// A chat session is held in memory (flowEngine.js): it is gone after a restart or a long idle spell.
// The engine then gets "session not found" and starts a fresh chat, resuming from the journal. The
// two messages are the ones the old Typebot endpoints used, kept so this check (and the tests that
// build those errors) stay valid:
//   continueChat       404 'Session not found.'
//   generateUploadUrl  400 "Can't find session"
export function isDeadSessionError(err) {
  if (err?.errorCode !== 'TYPEBOT_REQUEST_FAILED') return false;
  if (err.statusCode !== 404 && err.statusCode !== 400) return false;
  return /session not found|can'?t find session/i.test(String(err.message ?? ''));
}

export const typebotClient = {
  startChat,
  continueChat,
  generateUploadUrl,
  uploadToPresignedUrl,
};
