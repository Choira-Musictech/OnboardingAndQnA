// ==================================================================
// Registration engine - drives the Typebot-based onboarding flow.
// Relay model: this backend calls Typebot's Chat API on behalf of the
// frontend (frontend never talks to Typebot directly) - see
// modules/conversation/services/typebot/typebotClient.js. Session
// state (Typebot's sessionId + current input block) lives in
// typebotSessionStore. Response shape stays close to Typebot's own -
// no custom transformation, since the frontend's exact expectations
// aren't specified; adjust here if it needs a different shape.
// ==================================================================
import { badRequestError } from '../../../shared/errors.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { registrationService, OCR_TYPE_BY_DOC_TYPE } from '../../registration/services/registration.service.js';
import { typebotClient, isDeadSessionError } from '../services/typebot/typebotClient.js';
import { typebotSessionStore } from '../services/typebot/typebotSessionStore.js';
import { resolveDocumentType } from '../services/typebot/documentTypeMap.js';
import { resolveConversationField } from '../services/typebot/conversationFieldMap.js';
import {
  isWorkLinkStep,
  confirmsSong,
  wantsAnotherLink,
  isMoveOnKeyword,
  describeSong,
  describeCredits,
  MAX_WORK_LINKS,
  MAX_ALIAS_ATTEMPTS,
  WORK_LINK_CONFIRM_INPUT,
  WORK_LINK_ALIAS_INPUT,
  WORK_LINK_MORE_INPUT,
} from '../services/typebot/workLinkGate.js';
import {
  buildWorkDetailsQueue,
  inputForField,
  parseForField,
  describeWorkDetailsPrompt,
  describeWorkDetailsRetry,
} from '../services/typebot/workDetailsGate.js';
import { workLinkService } from '../../work/services/workLink.service.js';
import { resolveWorkLink } from '../../work/services/workLinkResolver.service.js';
import { matchCredits } from '../../work/services/workMatch.service.js';
import {
  isPaymentStep,
  describeReview,
  describePaymentPending,
  describePaymentReceived,
} from '../services/typebot/paymentGate.js';
import { paymentService } from '../../payment/services/payment.service.js';
import { registrationReviewService, renderSections } from '../../registration/services/registrationReview.service.js';
import { resolveProgress } from '../services/typebot/progressMap.js';
import {
  isEmailStep,
  isValidEmail,
  isResendKeyword,
  isChangeEmailKeyword,
  sendVerificationOtp,
  verifyVerificationOtp,
  describeOtpSent,
  describeOtpProblem,
  describeChangeLimitReached,
  MAX_EMAIL_CHANGES,
} from '../services/emailOtpGate.js';
import { isAddressProofTypeStep, resolveAddressProofOcrType, isManualAddressAnswer } from '../services/typebot/addressProofTypeMap.js';
import { conversationJournalService, REPLAY_STOP } from '../services/conversationJournal.service.js';
import { matchVerifyStep, verifyValue, describeVerifyFailure, describeVerifyError } from '../services/typebot/verifyGate.js';

// Only these fields are shown to the user for confirmation (per doc type,
// in this order) - see "Document Verification API" for the real OCR
// response shape. Everything else (isValid, documentType, holderTypeCode,
// accountNumberSource, ifscSource, ifscVerified, bankCode, branchCode) is
// internal/provenance metadata, not something a user confirms.
export const OCR_FIELD_LABELS = {
  PAN: { name: 'Name', pan: 'PAN Number', dob: 'Date of Birth', holderType: 'Holder Type' },
  AADHAAR: { name: 'Name', aadhaar: 'Aadhaar Number', dob: 'Date of Birth', gender: 'Gender', address: 'Address' },
  BANK: {
    bankName: 'Bank Name',
    accountNumber: 'Account Number',
    ifsc: 'IFSC Code',
    branch: 'Branch',
    city: 'City',
    state: 'State',
    micr: 'MICR Code',
  },
  // Not live on ocr.choira.io yet (see registration.service.js's OCR_DOC_TYPES comment) - wired
  // ahead of deployment. Curated user-facing subset of the "Document Verification API" collection's
  // fields, not the internal-only meta fields (detectionScore/formatTier/ocrValid/governmentVerified).
  DRIVING_LICENCE: {
    name: 'Name',
    drivingLicence: 'Licence Number',
    state: 'State',
    validTill: 'Valid Till',
    vehicleClasses: 'Vehicle Classes',
    issuingAuthority: 'Issuing Authority',
    address: 'Address',
  },
  VOTER_ID: {
    name: 'Name',
    epicNumber: 'EPIC Number',
    fatherOrHusbandName: 'Relation Name',
    gender: 'Gender',
    address: 'Address',
    state: 'State',
    assemblyConstituency: 'Assembly Constituency',
  },
  // `name` and `dob` are composed by normalizeExtracted() in registration.service.js - the passport
  // module itself returns surname/givenName and dateOfBirth. passportNumberValid (the MRZ check
  // digit) is deliberately not shown: it is provenance for staff, not something a member confirms.
  PASSPORT: {
    name: 'Name',
    passportNumber: 'Passport Number',
    dob: 'Date of Birth',
    dateOfExpiry: 'Valid Till',
    nationality: 'Nationality',
  },
  //
  // Same caveat as PAN/DRIVING_LICENCE above - collection only documents "Bill name + address" for
  // ELECTRICITY, not yet confirmed against a real success response.
  ELECTRICITY: { name: 'Name', address: 'Address' },
  // Confirmed live against a real GST certificate - see registration.service.js's normalizeExtracted.
  GST: { name: 'Legal Name', gstin: 'GSTIN', address: 'Address', pincode: 'Pincode' },
};

// Upload slots whose document type isn't known from the upload block itself - it was recorded a
// turn earlier from the paired "what type of document is this?" choice question (see
// addressProofTypeMap.js). Individual/NRI paths use the first two; the company paths add three more.
const ADDRESS_PROOF_UPLOAD_TYPES = new Set([
  'PERMANENT_ADDRESS_PROOF',
  'CURRENT_ADDRESS_PROOF',
  'REGISTERED_ADDRESS_PROOF',
  'COMM_ADDRESS_PROOF',
  'COMM_ADDRESS_PROOF_2',
]);

function isAffirmative(message) {
  const normalized = String(message ?? '').trim().toLowerCase();
  return ['yes, confirm', 'yes', 'y', 'confirm'].includes(normalized);
}

// "Is your current address the same as your permanent address?" - one per role path, confirmed via
// the published flow's builder-API export. Its answer carries no Typebot variableId (nothing in
// conversationFieldMap.js observes it), so it's detected by block id instead, the same technique
// paymentGate.js uses for the payment button.
const SAME_AS_ADDRESS_BLOCK_IDS = new Set([
  'i8v9h0dszpnwphwwl2mxf6te',
  'ddk7tlmjhkvt3zktskzt9i9e',
  'ctpx2z89l8pqltt5ehahmq3a',
  'cbmqojadjfm2jmbk9c17a59q',
]);

function textMessage(id, text) {
  return {
    id,
    type: 'text',
    content: { type: 'richText', richText: [{ type: 'p', children: [{ text }] }] },
  };
}

// Typebot drops the file name straight into the URL it hands back from generateUploadUrl, without
// encoding it - and then rejects that same URL on the next answer, because a URL containing raw
// spaces fails its own validation. Verified live: "Copy of Choira PAN.jpeg" produced
// ".../blocks/<id>/Copy of Choira PAN.jpeg" and came back "Invalid message. Please, try again.",
// while "pan.jpeg" went through. Phone file pickers hand over the original name, so this is exactly
// the sort of name real members upload.
//
// Sanitising here rather than encoding the URL later: the same URL is stored in DocumentCaption and
// is what ocr.choira.io is asked to fetch, so a clean name fixes every consumer at once. `#` and `?`
// matter as much as spaces - they truncate a URL rather than just invalidating it.
const MAX_FILE_NAME = 100;

export function safeFileName(name) {
  const raw = String(name ?? '').trim();
  const dot = raw.lastIndexOf('.');
  // Only treat a trailing dot group as an extension - a leading dot is a hidden file, not a name.
  const hasExt = dot > 0 && dot < raw.length - 1;
  const clean = (part) => part.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '');

  const stem = clean(hasExt ? raw.slice(0, dot) : raw).slice(0, MAX_FILE_NAME) || 'upload';
  const ext = hasExt ? clean(raw.slice(dot + 1)).slice(0, 10) : '';
  return ext ? `${stem}.${ext}` : stem;
}

// Shown when Typebot dropped an idle session and we started a fresh chat underneath the member.
// Typebot has no "resume at block X", so the questions do start again - but everything already
// answered is in our own database, not in Typebot's session, so say that plainly rather than
// letting them think the uploads are gone.
function describeSessionRestart() {
  return "You were away for a while, so the chat timed out and we've started it again. Nothing you already sent is lost - your uploaded documents and answers are saved.";
}

// Same situation, but hit on a file upload. The file can't be re-aimed at a chat that no longer has
// that question, so we don't silently restart here - we hand the next turn back to handle().
function describeSessionRestartOnUpload() {
  return "You were away for a while, so the chat timed out and this file wasn't attached. Your earlier documents and answers are saved - send any message to carry on, and we'll ask for it again.";
}

function buildOcrConfirmationMessages(docType, extracted) {
  const labels = OCR_FIELD_LABELS[docType] ?? {};
  const lines = Object.entries(labels)
    .map(([key, label]) => [label, extracted?.[key]])
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `${label}: ${value}`);

  return [
    textMessage('ocr-confirmation-intro', `We extracted the following ${docType} details:`),
    textMessage('ocr-confirmation-values', lines.join('\n')),
    textMessage('ocr-confirmation-prompt', 'Is this correct?'),
  ];
}

const OCR_CONFIRM_CHOICE_INPUT = {
  id: 'ocr-confirmation',
  type: 'choice input',
  items: [
    { id: 'ocr-confirm-yes', content: 'Yes, confirm' },
    { id: 'ocr-confirm-no', content: 'No, re-upload' },
  ],
};

// Synthetic block for the email-OTP step - not a real Typebot block, Studio
// needs no changes (same non-Typebot-block pattern as OCR_CONFIRM_CHOICE_INPUT). Stays a "text
// input" so the frontend keeps rendering the free-text composer (needed to type the OTP digits),
// but also carries `items` so the frontend can additionally show Resend/Change as tappable buttons
// - see Iprs-chatbot's Chat.jsx. The button labels are chosen to already match
// isResendKeyword/isChangeEmailKeyword below, so a tap and a typed keyword hit the same matcher.
const EMAIL_OTP_INPUT = {
  id: 'email-otp-verification',
  type: 'text input',
  options: {},
  items: [
    { id: 'email-otp-resend', content: 'Resend OTP' },
    { id: 'email-otp-change', content: 'Change email' },
  ],
};

// Offered to a member who left a registration unfinished and came back. Synthetic, same pattern as
// the two above.
const RESUME_CHOICE_INPUT = {
  id: 'resume-registration',
  type: 'choice input',
  items: [
    { id: 'resume-continue', content: 'Continue where I left off' },
    { id: 'resume-restart', content: 'Start over' },
  ],
};

// Deliberately only matches the destructive answer. The resume branch is the default, so a member
// who taps something unexpected keeps their progress instead of silently losing it.
function choosesRestart(message) {
  return /^\s*(start over|start again|restart|start from the beginning)\s*$/i.test(String(message ?? ''));
}

// The flow asks 30-odd questions, so someone returning after a gap has usually done real work. Lead
// with how far they got - it is the one thing that tells them the time was not wasted.
function describeResumeOffer(percent) {
  const sofar = Number.isInteger(percent) ? ` You'd completed about ${percent}% of it.` : '';
  return `Welcome back! You have a registration already in progress.${sofar}\n\nWould you like to carry on from where you left off, or start over?`;
}

// Replay put the member back mid-flow, so the question they now see is not the one they remember
// answering last - say why before Typebot's own message.
//
// Deliberately carries no percentage. The offer above quotes how far they GOT (the last block they
// answered); by here the flow has moved on to the next question, which scores slightly higher - and
// two different numbers a second apart reads as a bug. The live `progress` field still carries it.
function describeResumed() {
  return "Picking up where you left off. Here's the next question.";
}

// The published flow changed since they were last here, so their answers stop matching partway.
// Everything already saved is untouched; they just re-answer from the point the flow diverged.
function describeResumedPartially() {
  return "We've restored as much of your earlier registration as we could. Some questions have changed since you were last here, so we'll need a few answers again from this point.";
}

// What buildReview() found on file, worded for a member picking a conversation back up rather than
// about to pay. Only named/mapped fields - the same ones the payment review shows - not raw journal
// turns like "I Accept". `sections` is already empty-filtered by buildReview(), so nothing here
// decides what to include.
function describeResumeSummary(sections) {
  return `Here's what you told us earlier:\n\n${renderSections(sections)}`;
}

// Hold the conversation on the work-link step and ask again. Typebot is never advanced, so the
// member can retry as often as they need without burning one of their MAX_WORK_LINKS slots.
function askForAnotherLink(existing, text) {
  return {
    sessionEnded: false,
    messages: [textMessage('work-link-retry', text)],
    input: existing.input,
    progress: resolveProgress(existing.input.id),
  };
}

// Called once the member declines another link (WORK_LINK_MORE_INPUT's "No, continue"). Before
// handing the conversation back to Typebot, asks WorkCategory/LanguageNames/ReleaseYear for every
// saved song still missing one of them - see workDetailsGate.js for why these can't come from the
// credits services. `lastUrl` rides along in the pending state so it can still be replayed into
// Typebot once every question is answered, exactly as the old direct-replay path did.
// Returns null when nothing is missing (nothing to ask - the caller falls through to the replay
// immediately), or a full reply asking the first question.
async function startWorkDetailsFollowUp({ userId, existing, lastUrl }) {
  let rows = [];
  try {
    rows = await workLinkService.getWorkLinks(userId);
  } catch (err) {
    logger.warn({ userId, err }, 'Could not load saved work links for the details follow-up, skipping it');
    return null;
  }

  const queue = buildWorkDetailsQueue(rows);
  if (queue.length === 0) return null;

  typebotSessionStore.set(userId, {
    sessionId: existing.sessionId,
    input: existing.input,
    pendingWorkDetails: { lastUrl, queue, index: 0 },
  });

  const task = queue[0];
  return {
    sessionEnded: false,
    messages: [textMessage('work-details-ask', describeWorkDetailsPrompt(task))],
    input: inputForField(task.field),
    progress: resolveProgress(existing.input.id),
  };
}

// Once nothing more is owed for the song that was just saved (it had nothing missing, or the member
// just answered the last of its WorkCategory/LanguageNames/ReleaseYear questions), either offer
// another link slot or - at the cap - tell the caller to advance to Typebot.
// Returns either a full reply (under the cap: offered another link) or `{ advance, notice }` - the
// conversation should carry on to Typebot, and `notice` is what to tell the member on the way past.
function finishSaveOutcome({ userId, existing, atCap, lastUrl, saved }) {
  if (!atCap) {
    typebotSessionStore.set(userId, {
      sessionId: existing.sessionId,
      input: existing.input,
      pendingWorkLinkChoice: { lastUrl },
    });

    return {
      sessionEnded: false,
      messages: [textMessage('work-link-saved', `${saved} Would you like to add another?`)],
      input: WORK_LINK_MORE_INPUT,
      progress: resolveProgress(existing.input.id),
    };
  }

  return { advance: true, notice: `${saved} That's the maximum, so we'll move on.` };
}

// Persist the confirmed song, then ask its own WorkCategory/LanguageNames/ReleaseYear (whichever are
// missing - see workDetailsGate.js) right away, before offering another slot or falling through to
// Typebot - one song's questions feel like a natural continuation of "yes, that's my song", rather
// than saving every song's questions for one batch at the very end.
// Returns either a full reply (a details question, or - under the cap with nothing to ask - another
// link offered) or `{ advance, notice }` - the conversation should carry on to Typebot, and `notice`
// is what to tell the member on the way past. The notice matters: at the cap this used to return
// nothing at all, so the fifth link saved silently and a sixth was discarded silently, both while the
// other four each got a "Saved - that's N of 5" line. Confirming a song and being told nothing reads
// as a bug.
async function saveAndOfferAnother({ userId, existing, resolved, note }) {
  let count = null;
  let stored = null;
  try {
    // CreatedBy/ModifedBy record the member's own name - see workLink.service.js.
    const { accountName } = await registrationService.getIdentityNames(userId);
    stored = await workLinkService.saveWorkLink({ userId, resolved, accountName });
    count = await workLinkService.countWorkLinks(userId);
  } catch (err) {
    if (err.errorCode === 'WORK_LINK_DUPLICATE') {
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        pendingWorkLinkDuplicate: { url: resolved.url },
      });
      return {
        sessionEnded: false,
        messages: [textMessage('work-link-duplicate', 'You\'ve already added that song. Please share a different link, or tap "No, move on" to continue.')],
        input: { ...existing.input, items: [{ id: 'work-link-move-on', content: 'No, move on' }] },
        progress: resolveProgress(existing.input.id),
      };
    }
    // A storage failure must not strand the member on this step - log it and let the conversation
    // move on, same stance as the OCR persistence path.
    logger.warn({ userId, err }, 'Failed to save work link, advancing without the loop');
    return { advance: true, notice: null };
  }

  const saved = note ?? `Saved - that's ${count} of ${MAX_WORK_LINKS} links.`;

  // `stored` is null when saveWorkLink refused because the member was already at five before this
  // link - they confirmed a song that was not kept, so there's no new row to ask details about.
  if (!stored) {
    return { advance: true, notice: `You've already added the maximum of ${MAX_WORK_LINKS} links, so this one wasn't saved.` };
  }

  const atCap = count >= MAX_WORK_LINKS;
  const queue = buildWorkDetailsQueue([stored]);

  if (queue.length > 0) {
    typebotSessionStore.set(userId, {
      sessionId: existing.sessionId,
      input: existing.input,
      pendingWorkRowDetails: { queue, index: 0, lastUrl: resolved.url, atCap, saved },
    });

    const task = queue[0];
    return {
      sessionEnded: false,
      messages: [textMessage('work-details-ask', describeWorkDetailsPrompt(task))],
      input: inputForField(task.field),
      progress: resolveProgress(existing.input.id),
    };
  }

  return finishSaveOutcome({ userId, existing, atCap, lastUrl: resolved.url, saved });
}

// Returns a reply offering to resume, or null when there is nothing to resume and the caller should
// just start a normal chat. Never throws: if the journal can't be read, a first-question start is a
// worse experience but still a working one.
async function offerResume(userId) {
  let turns = 0;
  let lastBlock = null;
  try {
    turns = await conversationJournalService.countTurns(userId);
    if (turns === 0) return null;
    lastBlock = await conversationJournalService.lastBlockId(userId);
  } catch (err) {
    logger.warn({ userId, err }, 'Could not read the conversation journal - starting a fresh chat');
    return null;
  }

  typebotSessionStore.set(userId, { pendingResumeChoice: true });

  return {
    sessionEnded: false,
    messages: [textMessage('resume-offer', describeResumeOffer(resolveProgress(lastBlock)))],
    input: RESUME_CHOICE_INPUT,
    progress: resolveProgress(lastBlock),
  };
}

// Opens a fresh chat on the published flow and feeds the member's own answers back into it until it
// is asking what it was asking when they left. See conversationJournal.service.js for why this is a
// replay rather than a jump, and why it must not go back through handle().
async function resumeFromJournal({ userId, token }) {
  const turns = await conversationJournalService.loadJournal(userId);
  const startResponse = await typebotClient.startChat({
    prefilledVariables: { token, registrationId: userId },
  });

  const { response, replayed, stop } = await conversationJournalService.replayJournal({
    sessionId: startResponse.sessionId,
    startResponse,
    turns,
  });

  // A replay that stopped short leaves the rest of the journal describing a path the member is no
  // longer on. Cut it back so what they answer from here appends cleanly.
  if (stop !== REPLAY_STOP.COMPLETE && replayed < turns.length) {
    await conversationJournalService.truncateAfterReplay(userId, replayed);
  }

  logger.info({ userId, replayed, total: turns.length, stop }, 'Resumed a registration from its journal');

  // Replay ran the flow to its end - they had actually finished, so treat this exactly as the relay
  // does when it runs out of questions.
  if (!response.input) {
    typebotSessionStore.clear(userId);
    await conversationJournalService.clearJournal(userId);
    try {
      await registrationService.complete(userId, userId);
    } catch (err) {
      if (err.errorCode !== 'REGISTRATION_INCOMPLETE') {
        logger.warn({ userId, err }, 'Failed to auto-complete registration while resuming');
      }
    }
    return { sessionEnded: true, messages: response.messages ?? [], input: null, progress: 100 };
  }

  typebotSessionStore.set(userId, { sessionId: startResponse.sessionId, input: response.input });

  const notice = stop === REPLAY_STOP.COMPLETE ? describeResumed() : describeResumedPartially();

  // Reminds the member what they already told us, before the "picking up" notice. Read straight
  // from the database, not the journal: those fields were persisted the first time the member
  // answered them, and replay above never re-writes them, so this is already correct without
  // re-deriving anything from the journal's raw turns. A summary must never block the resume
  // itself - buildReview() failing is a lesser problem than the member being stuck.
  let summaryMessage = null;
  try {
    const sections = await registrationReviewService.buildReview(userId);
    if (sections.length) summaryMessage = textMessage('resume-summary', describeResumeSummary(sections));
  } catch (err) {
    logger.warn({ userId, err }, 'Could not build the resume summary, continuing without it');
  }

  return {
    sessionEnded: false,
    messages: [
      ...(summaryMessage ? [summaryMessage] : []),
      textMessage('resume-restored', notice),
      ...(response.messages ?? []),
    ],
    input: response.input,
    progress: resolveProgress(response.input.id),
  };
}

/**
 * @param {{ userId: string, token: string, message?: string, attachedFileUrls?: string[] }} input
 */
export async function handle(args) {
  const result = await handleCore(args);
  // A stable, explicit signal for the frontend: "this input is the real payment button - call
  // POST /payment/initiate instead of relaying it as a chat message." Without this the frontend
  // would have to guess by matching Typebot's own block ids or button label text, which breaks
  // silently on republish (same fragility paymentGate.js's own PAYMENT_BLOCK_IDS comment warns
  // about) - one central place computes it here instead of at every return statement below,
  // including the ones inside resumeFromJournal() that this wraps too.
  return { ...result, isPaymentStep: isPaymentStep(result.input?.id) };
}

async function handleCore({ userId, token, message, attachedFileUrls }) {
  // A blank message is not an answer to anything - Typebot rejects empty text on every input type,
  // and the validator lets `message: ""` through, so a client that always sends the field (Apidog,
  // a form that posts an empty box) would otherwise be treated as if it had said something. Every
  // "is this a start call?" test below compares against undefined, so normalise here rather than
  // widening each one - this is also what lets `text` fall through to attachedFileUrls further
  // down, where `??` would keep an empty string and send that instead of the file.
  if (typeof message === 'string' && !message.trim()) message = undefined;

  let existing = typebotSessionStore.get(userId);
  let bypassEmailGate = false;
  let bypassWorkLinkSave = false;
  // Something to tell the member about their work link while the conversation moves past the step -
  // prepended to Typebot's own reply at the end of the relay.
  let workLinkNotice = null;

  // A stored session can be a leftover from an earlier, never-finished
  // conversation (in-memory store, only clears on completion or server
  // restart - logging in again doesn't touch it). An empty call (no
  // message, no attachedFileUrls) is never a valid answer to a real
  // pending question - it's exactly the shape of a genuine "start" call -
  // so treat it as intent to start over rather than failing with
  // "Invalid message" against a question the caller doesn't know about.
  if (existing && message === undefined && (!attachedFileUrls || attachedFileUrls.length === 0)) {
    logger.warn({ userId }, 'Discarding stale conversation session on empty start call');
    typebotSessionStore.clear(userId);
    existing = null;
  }

  // Resolve a pending resume offer. Checked before every other gate because the member is answering
  // "carry on or start over?", not any question in the flow.
  if (existing?.pendingResumeChoice && message !== undefined) {
    // Only an explicit "start over" throws the progress away. Anything else - a stray tap, a typo,
    // a frontend that echoes something unexpected - resumes, because the destructive branch is the
    // one that must never be reached by accident.
    if (!choosesRestart(message)) {
      return resumeFromJournal({ userId, token });
    }

    // The journal has to go with it, or the next empty start call offers to resume the registration
    // they just chose to abandon.
    await conversationJournalService.clearJournal(userId);

    // Work links are append-only with a hard cap, so - unlike documents or account fields, which
    // stay untouched here on purpose - a song added before this restart would otherwise still count
    // against MAX_WORK_LINKS and reappear in the payment review / resume summary even though the
    // member only added one link since choosing to start over. Never lets a delete failure block the
    // restart itself.
    try {
      await workLinkService.clearWorkLinks(userId);
    } catch (err) {
      logger.warn({ userId, err }, 'Failed to clear work links on restart, continuing');
    }

    typebotSessionStore.clear(userId);
    existing = null;
    message = undefined;
  }

  // No live session and nothing pending: this is either a first-time member or one coming back to
  // an unfinished registration. Offer the choice before starting a chat, so "start over" doesn't
  // burn a Typebot session we'd immediately throw away.
  if (!existing && message === undefined && (!attachedFileUrls || attachedFileUrls.length === 0)) {
    const offer = await offerResume(userId);
    if (offer) return offer;
  }

  // Resolve a pending OCR-confirmation before doing anything else - the
  // incoming `message` answers "is this correct?", not whatever Typebot
  // question was live before the upload.
  if (existing?.pendingDocConfirmation && message !== undefined) {
    const { fileUrl } = existing.pendingDocConfirmation;

    // typebotSessionStore.set() replaces the whole session object, so addressProofOcrType has to be
    // carried forward explicitly here - otherwise a reupload silently loses it and the second OCR
    // attempt falls back to the generic doc type, which isn't an OCR type, so extraction is skipped.
    const carriedAddressProofOcrType =
      existing.addressProofOcrType !== undefined ? { addressProofOcrType: existing.addressProofOcrType } : {};

    if (!isAffirmative(message)) {
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        ...carriedAddressProofOcrType,
      });
      return {
        sessionEnded: false,
        messages: [textMessage('ocr-confirmation-rejected', 'No problem - please upload the document again.')],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    // Confirmed: replay this exactly as handleUpload() would have advanced
    // the conversation before this confirmation step existed.
    typebotSessionStore.set(userId, {
      sessionId: existing.sessionId,
      input: existing.input,
      ...carriedAddressProofOcrType,
    });
    existing = typebotSessionStore.get(userId);
    message = undefined;
    attachedFileUrls = [fileUrl];
  }

  // Resolve a pending email-OTP verification before anything else - the
  // incoming `message` answers "what's the OTP?" (or "resend"), not the
  // original email question.
  if (existing?.pendingEmailVerification && message !== undefined) {
    const { email } = existing.pendingEmailVerification;
    // typebotSessionStore.set() replaces the whole session object, so this counter has to be
    // carried forward explicitly by every set() on the email path - the OTP send, the change
    // branch and the post-verification replay. Miss one and the cap silently resets.
    const emailChanges = existing.emailChanges ?? 0;

    // A mistyped address is the one way this step used to wedge for good: no code ever arrives,
    // every guess fails, and resending just mails the same wrong address.
    if (isChangeEmailKeyword(message)) {
      if (emailChanges >= MAX_EMAIL_CHANGES) {
        return {
          sessionEnded: false,
          messages: [textMessage('email-change-limit', describeChangeLimitReached())],
          input: EMAIL_OTP_INPUT,
          progress: resolveProgress(existing.input.id),
        };
      }

      // Hand back the real Typebot email block. The next answer re-enters the email gate below and
      // is validated, duplicate-checked and sent an OTP exactly like the first one was.
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        emailChanges: emailChanges + 1,
      });

      return {
        sessionEnded: false,
        messages: [textMessage('email-change-prompt', 'No problem - what email address should we use instead?')],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    if (isResendKeyword(message)) {
      try {
        await sendVerificationOtp(email);
        return {
          sessionEnded: false,
          messages: [textMessage('email-otp-resent', describeOtpSent(email))],
          input: EMAIL_OTP_INPUT,
          progress: resolveProgress(existing.input.id),
        };
      } catch (err) {
        return {
          sessionEnded: false,
          messages: [textMessage('email-otp-resend-failed', describeOtpProblem(err.message))],
          input: EMAIL_OTP_INPUT,
          progress: resolveProgress(existing.input.id),
        };
      }
    }

    try {
      await verifyVerificationOtp(email, message);
    } catch (err) {
      return {
        sessionEnded: false,
        messages: [textMessage('email-otp-invalid', describeOtpProblem(err.message))],
        input: EMAIL_OTP_INPUT,
        progress: resolveProgress(existing.input.id),
      };
    }

    // Verified: replay this exactly as if the user had just answered the
    // original email question correctly - existing.input stays the real
    // Typebot email-input block, so the normal relay/persist logic below
    // treats `email` as the answer to it.
    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input, emailChanges });
    existing = typebotSessionStore.get(userId);
    bypassEmailGate = true;
    message = email;
  }

  // The payment button is where this flow stops. Paying happens through /payment/initiate and the
  // PayU callback, never through Typebot - so an answer arriving here is not a payment, it's a
  // member typing into the chat. Relaying it used to hand Typebot the button's own answer, which
  // played its scripted "Thank you for your payment.", ended the session and cleared the journal,
  // all for a member who had paid nothing. Hold them on the button instead.
  if (existing?.input && isPaymentStep(existing.input.id) && message !== undefined) {
    const paid = await paymentService.hasSuccessfulPayment(userId);
    return {
      sessionEnded: false,
      messages: [
        textMessage('payment-pending', paid ? describePaymentReceived(userId) : describePaymentPending()),
      ],
      input: existing.input,
      progress: resolveProgress(existing.input.id),
    };
  }

  // Resolve a pending "is this your song?" answer. Nothing has been written yet at this point -
  // "No" simply drops the resolved song and re-asks, so a wrong link leaves no trace.
  if (existing?.pendingWorkLinkConfirm && message !== undefined) {
    const { resolved } = existing.pendingWorkLinkConfirm;
    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input });
    existing = typebotSessionStore.get(userId);

    if (!confirmsSong(message)) {
      return askForAnotherLink(existing, 'No problem - please share the correct link to your song.');
    }

    // Names already on file: the identity-document name and the registration stage name are
    // evidence; aliases the member gave at this step on an earlier song are only their own claim.
    const { trusted, claimed } = await registrationService.getIdentityNames(userId);
    const { matched } = matchCredits(resolved, trusted, claimed);

    if (!matched) {
      // Not in the credits. The usual reason is a stage name we don't have on file rather than a
      // false claim, so ask for it instead of blocking - see AGENTS.md.
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        pendingWorkLinkAlias: { resolved, attempts: 0 },
      });

      return {
        sessionEnded: false,
        messages: [textMessage('work-link-credits-mismatch', describeCredits(resolved))],
        input: WORK_LINK_ALIAS_INPUT,
        progress: resolveProgress(existing.input.id),
      };
    }

    const outcome = await saveAndOfferAnother({ userId, existing, resolved });
    if (!outcome.advance) return outcome;
    // At the cap: replay the url as the answer to the real Typebot step so the conversation
    // advances exactly as it would have without the loop, with the save bypassed. The notice
    // rides along so the member still hears what happened to the link they just confirmed.
    workLinkNotice = outcome.notice;
    bypassWorkLinkSave = true;
    message = resolved.url;
  }

  // Resolve a pending "what name are you credited under?" answer.
  if (existing?.pendingWorkLinkAlias && message !== undefined) {
    const { resolved, attempts } = existing.pendingWorkLinkAlias;
    const alias = message;
    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input });
    existing = typebotSessionStore.get(userId);

    // The member may give several names at once ("Aditya Prateek, AP").
    const names = registrationService.parseAliasList(alias);

    // Stored whether or not they match *this* song - that is the point of collecting them, and the
    // member's next links are matched against them without asking again. Never trusted: they were
    // supplied after we showed the credit list, so a match here is a claim, not a check.
    if (names.length > 0) {
      await registrationService.addAliases(userId, names).catch((err) => {
        logger.warn({ userId, err }, 'Could not store the credited names');
      });
    }

    const { matched } = matchCredits(resolved, [], names);

    if (!matched && attempts + 1 < MAX_ALIAS_ATTEMPTS) {
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        pendingWorkLinkAlias: { resolved, attempts: attempts + 1 },
      });

      return {
        sessionEnded: false,
        messages: [
          textMessage(
            'work-link-alias-retry',
            "That name isn't in the credits either. Please check how your name appears on the release and enter it exactly.",
          ),
        ],
        input: WORK_LINK_ALIAS_INPUT,
        progress: resolveProgress(existing.input.id),
      };
    }

    // Either the supplied name is in the credits, or attempts ran out - both save. A member must
    // never be stuck on this step.
    const outcome = await saveAndOfferAnother({
      userId,
      existing,
      resolved,
      note: matched
        ? "Thanks - we've saved this song, and we'll remember that name for your next one."
        : "We've saved this song. Our team will verify your credit on it.",
    });
    if (!outcome.advance) return outcome;
    workLinkNotice = outcome.notice;
    bypassWorkLinkSave = true;
    message = resolved.url;
  }

  // Resolve a pending per-song WorkCategory/LanguageNames/ReleaseYear answer - asked immediately
  // after that song was confirmed and saved (see saveAndOfferAnother), one field at a time. Once its
  // small queue is empty, continues exactly where saveAndOfferAnother would have: offering another
  // link slot, or - at the cap - falling through to Typebot via the same bypass/replay every other
  // path through this loop uses.
  if (existing?.pendingWorkRowDetails && message !== undefined) {
    const { queue, index, lastUrl, atCap, saved } = existing.pendingWorkRowDetails;
    const task = queue[index];
    const value = parseForField(task.field, message);

    if (value == null) {
      return {
        sessionEnded: false,
        messages: [textMessage('work-details-retry', describeWorkDetailsRetry(task))],
        input: inputForField(task.field),
        progress: resolveProgress(existing.input.id),
      };
    }

    try {
      await workLinkService.updateWorkDetails(task.workNotificationId, {
        [task.field]: task.field === 'ReleaseYear' ? BigInt(value) : value,
      });
    } catch (err) {
      logger.warn({ userId, err, task }, 'Could not save a work-details answer, moving on without it');
    }

    const nextIndex = index + 1;
    if (nextIndex < queue.length) {
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        pendingWorkRowDetails: { queue, index: nextIndex, lastUrl, atCap, saved },
      });
      const nextTask = queue[nextIndex];
      return {
        sessionEnded: false,
        messages: [textMessage('work-details-ask', describeWorkDetailsPrompt(nextTask))],
        input: inputForField(nextTask.field),
        progress: resolveProgress(existing.input.id),
      };
    }

    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input });
    existing = typebotSessionStore.get(userId);

    const outcome = finishSaveOutcome({ userId, existing, atCap, lastUrl, saved });
    if (!outcome.advance) return outcome;
    workLinkNotice = outcome.notice;
    bypassWorkLinkSave = true;
    message = lastUrl;
  }

  // Resolve a pending "add another link?" answer - the incoming `message`
  // answers that synthetic question, not the real Typebot one underneath.
  // "Yes" re-asks for a link without advancing Typebot; "No" falls through
  // to the normal relay, which advances past the link step.
  if (existing?.pendingWorkLinkChoice && message !== undefined) {
    const { lastUrl } = existing.pendingWorkLinkChoice;
    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input });
    existing = typebotSessionStore.get(userId);

    if (wantsAnotherLink(message)) {
      return {
        sessionEnded: false,
        messages: [textMessage('work-link-next', 'Please share the next link to your work.')],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    // Declined - before replaying the last link into the real Typebot step, ask WorkCategory/
    // LanguageNames/ReleaseYear for every song saved this session that's still missing one. Nothing
    // missing means startWorkDetailsFollowUp returns null and the replay happens immediately, exactly
    // as before.
    const detailsFollowUp = await startWorkDetailsFollowUp({ userId, existing, lastUrl });
    if (detailsFollowUp) return detailsFollowUp;

    // bypassWorkLinkSave stops that replay from saving the same link twice.
    bypassWorkLinkSave = true;
    message = lastUrl;
  }

  // Resolve a pending WorkCategory/LanguageNames/ReleaseYear follow-up answer - one field at a time,
  // across every song still missing one (see startWorkDetailsFollowUp / workDetailsGate.js). Once the
  // queue is empty, replays the last work link into Typebot exactly like the direct-decline path.
  if (existing?.pendingWorkDetails && message !== undefined) {
    const { lastUrl, queue, index } = existing.pendingWorkDetails;
    const task = queue[index];
    const value = parseForField(task.field, message);

    if (value == null) {
      return {
        sessionEnded: false,
        messages: [textMessage('work-details-retry', describeWorkDetailsRetry(task))],
        input: inputForField(task.field),
        progress: resolveProgress(existing.input.id),
      };
    }

    try {
      await workLinkService.updateWorkDetails(task.workNotificationId, {
        [task.field]: task.field === 'ReleaseYear' ? BigInt(value) : value,
      });
    } catch (err) {
      logger.warn({ userId, err, task }, 'Could not save a work-details answer, moving on without it');
    }

    const nextIndex = index + 1;
    if (nextIndex < queue.length) {
      typebotSessionStore.set(userId, {
        sessionId: existing.sessionId,
        input: existing.input,
        pendingWorkDetails: { lastUrl, queue, index: nextIndex },
      });
      const nextTask = queue[nextIndex];
      return {
        sessionEnded: false,
        messages: [textMessage('work-details-ask', describeWorkDetailsPrompt(nextTask))],
        input: inputForField(nextTask.field),
        progress: resolveProgress(existing.input.id),
      };
    }

    // All questions answered - replay the last link into the real Typebot step, same as the
    // no-questions-missing path.
    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input });
    existing = typebotSessionStore.get(userId);
    bypassWorkLinkSave = true;
    message = lastUrl;
  }

  // Resolve a pending duplicate-link notice. Unlike pendingWorkLinkChoice above, this step keeps
  // the real url-input block active (with a "No, move on" button attached, not a synthetic choice
  // input) so the member can still paste a fresh link directly - only the exact move-on keyword
  // bypasses/replays; anything else (including a real link) falls through unchanged into the
  // normal isWorkLinkStep resolution below, exactly as if the duplicate had never happened.
  if (existing?.pendingWorkLinkDuplicate && message !== undefined) {
    const { url } = existing.pendingWorkLinkDuplicate;
    typebotSessionStore.set(userId, { sessionId: existing.sessionId, input: existing.input });
    existing = typebotSessionStore.get(userId);

    if (isMoveOnKeyword(message)) {
      bypassWorkLinkSave = true;
      message = url;
    }
  }

  // Work links: the member may claim up to MAX_WORK_LINKS songs, but the flow asks once. Everything
  // between the paste and the save is driven from here with synthetic blocks (see workLinkGate.js):
  // identify the provider, fetch the song, show it back for confirmation, and - when the credits
  // don't carry the member's name - ask which name they are credited under. Nothing is written until
  // the member has confirmed the song; a rejected or unrecognised link never reaches Typebot, so the
  // session stays on this step and the question simply repeats.
  if (!bypassWorkLinkSave && existing?.input && message && isWorkLinkStep(existing.input.options?.variableId)) {
    let resolved;
    try {
      resolved = await resolveWorkLink(message);
    } catch (err) {
      logger.warn({ userId, err }, 'Could not resolve work link');
      return askForAnotherLink(existing, "We couldn't read that link. Please check it and share the link to your song again.");
    }

    if (!resolved) {
      return askForAnotherLink(existing, 'Please share a Spotify or YouTube link to your song.');
    }

    if (!resolved.isMusicVideo) {
      return askForAnotherLink(existing, "That doesn't look like a song. Please share a link to your song.");
    }

    typebotSessionStore.set(userId, {
      sessionId: existing.sessionId,
      input: existing.input,
      pendingWorkLinkConfirm: { resolved },
    });

    return {
      sessionEnded: false,
      messages: [textMessage('work-link-confirm', describeSong(resolved))],
      input: WORK_LINK_CONFIRM_INPUT,
      progress: resolveProgress(existing.input.id),
    };
  }

  // The GST-number step is gated: a fresh answer is checked against the government-lookup verify
  // service before it's relayed to Typebot or persisted at all. Only a genuine service/transport
  // problem blocks it (see httpVerifyProvider.js's pass/fail rule) - on that failure the same
  // question is re-asked (input: existing.input, no typebotSessionStore.set() with a new input, no
  // continueChat call) so Typebot's session never advances mid-failure, same guarantee as the
  // email-OTP gate below. Once the service responds successfully, `message` is unchanged and falls
  // through to the normal relay/persist path further down - GST's existing Detail1 write keeps
  // working exactly as before. See verifyGate.js.
  //
  // env.GST_VERIFY_ENABLED (default true) is a blanket kill-switch, same shape/purpose as
  // OCR_ENABLED: set to false locally to test the chat flow past this step without a real,
  // valid-format GSTIN on hand. When off, the step is never matched, so the answer is saved
  // unchecked - same as any other unguarded text field.
  const verifyStep = env.GST_VERIFY_ENABLED && existing?.input && message && matchVerifyStep(existing.input.options?.variableId);
  if (verifyStep) {
    let verifyResult;
    try {
      verifyResult = await verifyValue(verifyStep.docType, message);
    } catch (err) {
      logger.warn({ userId, docType: verifyStep.docType, err }, 'Verification call failed');
      // Only a verdict about the NUMBER is worth repeating to the member, and the error's
      // `code` is what says whose fault it was - not the mere presence of a message, which
      // every refusal carries. A *_VERIFICATION_UNAVAILABLE means the registry could not be
      // asked at all: the GST department's own backend answers "Backend Timed Out. Try
      // Again." routinely, and that arrives here with a message, so telling the member to
      // check a number that is very likely correct sent them round a loop they could not
      // win. Anything that is not explicitly the number's fault gets the retry-safe wording.
      const code = err.details?.code;
      const blamesTheValue = typeof code === 'string' && code.endsWith('_MALFORMED');
      const reason = blamesTheValue && typeof err.details?.message === 'string'
        ? err.details.message
        : null;
      return {
        sessionEnded: false,
        messages: [textMessage('verify-call-failed', describeVerifyError(verifyStep.label, reason))],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    if (!verifyResult.verified) {
      return {
        sessionEnded: false,
        messages: [textMessage('verify-failed', describeVerifyFailure(verifyStep.label, verifyResult.message))],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }
  }

  // The email step is gated: a fresh answer to "Provide your email id"
  // triggers an OTP send instead of relaying straight to Typebot - the
  // conversation only advances once verifyVerificationOtp() succeeds
  // (handled above, on a later turn). Skipped on the post-verification
  // replay (bypassEmailGate) so a just-verified email doesn't re-trigger
  // a fresh OTP send.
  if (!bypassEmailGate && existing?.input && message && isEmailStep(existing.input.options?.variableId)) {
    if (!isValidEmail(message)) {
      return {
        sessionEnded: false,
        messages: [textMessage('email-invalid-format', 'That doesn\'t look like a valid email address. Please enter a valid email.')],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    // One account per email. Checked before the OTP is sent, so the member isn't walked through a
    // verification whose result could never be saved - and no mail is wasted on it either. The
    // filtered unique index on App_Accounts(AccountEmail) is the real guarantee; this is the
    // message that makes it comprehensible.
    if (await registrationService.isEmailTakenByAnotherAccount(userId, message)) {
      return {
        sessionEnded: false,
        messages: [textMessage('email-already-registered', 'That email is already registered to another account. Please enter a different one.')],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    try {
      await sendVerificationOtp(message);
    } catch (err) {
      return {
        sessionEnded: false,
        messages: [textMessage('email-otp-send-failed', err.message)],
        input: existing.input,
        progress: resolveProgress(existing.input.id),
      };
    }

    typebotSessionStore.set(userId, {
      sessionId: existing.sessionId,
      input: existing.input,
      pendingEmailVerification: { email: message },
      emailChanges: existing.emailChanges ?? 0,
    });

    return {
      sessionEnded: false,
      messages: [textMessage('email-otp-sent', describeOtpSent(message))],
      input: EMAIL_OTP_INPUT,
      progress: resolveProgress(existing.input.id),
    };
  }

  // Typebot's own widget puts the file URL(s) in `text` too (not just
  // attachedFileUrls) when answering a file-input step - an empty text
  // answers gets rejected as "Invalid message" even though the docs say
  // text may be empty. Mirror the widget's behavior exactly.
  const text = message ?? (attachedFileUrls?.length ? attachedFileUrls.join(', ') : '');

  const beginChat = () => typebotClient.startChat({ prefilledVariables: { token, registrationId: userId } });

  // The question this `message` is answering. Captured before the relay because an expired session
  // drops `existing` - the answer is still valid and still worth persisting, even though Typebot
  // has forgotten where it asked it.
  const answeredInput = existing?.input;
  let sessionExpired = false;
  let response;

  if (existing) {
    try {
      response = await typebotClient.continueChat({
        sessionId: existing.sessionId,
        message: { type: 'text', text, attachedFileUrls },
      });
    } catch (err) {
      if (!isDeadSessionError(err)) throw err;
      // Typebot dropped the session while the member was idle. Without this the same dead id goes
      // out on every later message and they can never get out - see typebotClient.isDeadSessionError.
      // One restart only: beginChat() failing is a real failure and must surface.
      logger.warn({ userId, sessionId: existing.sessionId }, 'Typebot session expired - restarting the conversation');
      typebotSessionStore.clear(userId);
      existing = null;
      sessionExpired = true;
      response = await beginChat();
    }
  } else {
    response = await beginChat();
  }

  // `message` answers the question the user was just asked (answeredInput),
  // not the new one in `response.input` - persist it before overwriting the session.
  let addressProofOcrType;
  if (answeredInput && message) {
    const field = resolveConversationField(answeredInput.options?.variableId);
    if (field) {
      try {
        await registrationService.saveConversationField(userId, userId, field, message);
      } catch (err) {
        logger.warn({ userId, field, err }, 'Failed to persist conversation answer, continuing relay');
      }
    }

    if (SAME_AS_ADDRESS_BLOCK_IDS.has(answeredInput.id) && isAffirmative(message)) {
      try {
        await registrationService.copyPermanentAddressToCurrent(userId);
      } catch (err) {
        logger.warn({ userId, err }, 'Failed to copy permanent address to current, continuing relay');
      }
    }

    // Remember which document type the user just picked for their permanent/current address
    // proof - the paired file-upload question (next turn) has no way to know this on its own,
    // since the upload lands in one shared variable regardless of type. Consulted by
    // handleUpload() to decide OCR routing (see addressProofTypeMap.js).
    if (isAddressProofTypeStep(answeredInput.options?.variableId)) {
      addressProofOcrType = resolveAddressProofOcrType(message);
      if (addressProofOcrType === null && !isManualAddressAnswer(message)) {
        logger.warn({ userId, message }, 'Address-proof type answer did not resolve to an OCR type');
      }
    }
  }

  // Journal the answer so this registration can be resumed if the member walks away. Two things
  // must be true first, and neither is obvious from the response alone:
  //   - Typebot ACCEPTED it. A rejected answer comes back 200 with the SAME input repeated, so an
  //     unchecked write would journal "Invalid message" turns and replay the member into a loop.
  //   - the session didn't just expire. Then the answer was never delivered - `response` is a fresh
  //     chat at question 1, which looks like acceptance but isn't.
  // What goes in is `text`, i.e. what was RELAYED, not what the member typed: the gates above
  // transform answers, and replaying the relayed value is what keeps a resume free of side effects.
  if (answeredInput && !sessionExpired && response.input?.id !== answeredInput.id) {
    await conversationJournalService.recordTurn({
      userId,
      blockId: answeredInput.id,
      variableId: answeredInput.options?.variableId,
      answer: text,
      attachedFileUrls,
    });
  }

  // continueChat's response doesn't repeat sessionId - keep the one we already have.
  const sessionId = existing ? existing.sessionId : response.sessionId;
  const ended = !response.input;

  if (ended) {
    typebotSessionStore.clear(userId);
    // Nothing left to resume to - the flow has no more questions. Held even when complete() below
    // reports the registration still incomplete, since a journal can only restore a position and
    // there is no position left.
    await conversationJournalService.clearJournal(userId);
    // Mark the registration complete in-process now that the Typebot flow has
    // genuinely run out of questions - don't rely on a Studio HTTP block to do
    // this externally (same reasoning as handleUpload() saving documents
    // in-process). complete() is idempotent and validates basic details +
    // required docs itself; REGISTRATION_INCOMPLETE is an expected outcome
    // for an early/abandoned session, not a failure worth warning about.
    try {
      await registrationService.complete(userId, userId);
    } catch (err) {
      if (err.errorCode === 'REGISTRATION_INCOMPLETE') {
        logger.info({ userId, missing: err.details?.missing }, 'Typebot session ended but registration is still incomplete');
      } else {
        logger.warn({ userId, err }, 'Failed to auto-complete registration on session end');
      }
    }
  } else {
    typebotSessionStore.set(userId, {
      sessionId,
      input: response.input,
      ...(addressProofOcrType !== undefined ? { addressProofOcrType } : {}),
    });
  }

  // Notices that explain something about *this* turn, above whatever Typebot said. The expiry one
  // goes first: it explains why the member is suddenly looking at the first question again.
  const notices = [
    ...(sessionExpired ? [textMessage('session-expired', describeSessionRestart())] : []),
    ...(workLinkNotice ? [textMessage('work-link-cap', workLinkNotice)] : []),
  ];
  const messages = notices.length ? [...notices, ...(response.messages ?? [])] : (response.messages ?? []);

  // Typebot just offered the payment button. Show the member everything on file first, in the same
  // turn as the real payment button - much of it was read off their documents by OCR rather than
  // typed, and this is the last point at which a wrong bank account number can still be caught.
  // Typebot's own messages are kept above the review, so nothing the flow said is lost. There is no
  // separate confirmation step: the review is informational, the button is always right there.
  if (!ended && isPaymentStep(response.input?.id)) {
    try {
      const sections = await registrationReviewService.buildReview(userId);

      return {
        sessionEnded: false,
        messages: [...messages, textMessage('payment-review', describeReview(sections))],
        input: response.input,
        progress: resolveProgress(response.input.id),
      };
    } catch (err) {
      // Never block payment because the summary couldn't be built - fall through to the button.
      logger.warn({ userId, err }, 'Could not build the pre-payment review, showing payment directly');
    }
  }

  return {
    sessionEnded: ended,
    messages,
    input: response.input ?? null,
    progress: ended ? 100 : resolveProgress(response.input?.id),
  };
}

// Handles a raw file upload for the current file-input step: gets a
// presigned URL from Typebot, uploads the bytes, persists the document
// (+ OCR, via the same saveDocument() the old Studio HTTP blocks used
// to call) when the current block maps to a known document type, then
// advances the conversation exactly like a normal message would.
/**
 * @param {{ userId: string, token: string, file: { originalname: string, mimetype: string, size: number, buffer: Buffer } }} input
 */
export async function handleUpload(args) {
  const result = await handleUploadCore(args);
  // Same stable contract as handle() - see its comment. A file upload never itself lands on the
  // payment button, but keeping the field present on every response (rather than only from
  // handle()) means the frontend never has to special-case which endpoint it called.
  return { ...result, isPaymentStep: isPaymentStep(result.input?.id) };
}

async function handleUploadCore({ userId, token, file }) {
  const session = typebotSessionStore.get(userId);
  if (!session?.input || session.input.type !== 'file input') {
    throw badRequestError('No active file-upload step in the conversation');
  }

  const { id: blockId, options } = session.input;
  const variableId = options?.variableId;

  let upload;
  try {
    upload = await typebotClient.generateUploadUrl({
      sessionId: session.sessionId,
      blockId,
      fileName: safeFileName(file.originalname),
      fileType: file.mimetype,
      fileSize: file.size,
    });
  } catch (err) {
    if (!isDeadSessionError(err)) throw err;
    // Typebot expired the session while the member was picking a file. `blockId` belongs to a
    // question that no longer exists, so this upload cannot be salvaged - but leaving the dead
    // session in the store would wedge every later message too. Restart the chat so they land on a
    // real question with a working input, and say why the file didn't go through.
    logger.warn({ userId, sessionId: session.sessionId }, 'Typebot session expired during upload - restarting the conversation');
    typebotSessionStore.clear(userId);

    const restarted = await typebotClient.startChat({ prefilledVariables: { token, registrationId: userId } });
    if (restarted.input) {
      typebotSessionStore.set(userId, { sessionId: restarted.sessionId, input: restarted.input });
    }

    return {
      sessionEnded: !restarted.input,
      messages: [
        textMessage('session-expired-upload', describeSessionRestartOnUpload()),
        ...(restarted.messages ?? []),
      ],
      input: restarted.input,
      progress: restarted.input ? resolveProgress(restarted.input.id) : 100,
    };
  }

  const { presignedUrl, formData, fileUrl } = upload;

  await typebotClient.uploadToPresignedUrl({
    presignedUrl,
    formData,
    fileBuffer: file.buffer,
    fileName: file.originalname,
    fileType: file.mimetype,
  });

  const docType = resolveDocumentType(variableId);
  // Address-proof uploads (permanent/current) don't carry their own document type - it was
  // recorded a turn earlier from the paired type-choice question (see addressProofTypeMap.js /
  // registrationEngine.handle()). null means an unsupported type (Passport/Letter from Property
  // Owner) or none recorded - saveDocument() falls back to docType itself, which isn't in
  // OCR_DOC_TYPES, so OCR is correctly skipped.
  const isAddressProofUpload = ADDRESS_PROOF_UPLOAD_TYPES.has(docType);
  const ocrDocType = isAddressProofUpload ? session.addressProofOcrType : undefined;
  if (isAddressProofUpload && ocrDocType == null) {
    logger.warn({ userId, docType }, 'Address-proof upload has no OCR type recorded in session - OCR will be skipped');
  }

  let result = null;
  if (docType) {
    result = await registrationService.saveDocument(userId, userId, docType, fileUrl, ocrDocType);
  }

  // OCR was attempted (result carries an `extracted` key, even if null) -
  // gate on the user confirming what was read, or ask for a better image
  // if nothing could be read at all. Non-OCR doc types (no `extracted` key
  // present) fall straight through to the normal advance, unchanged.
  if (result && Object.prototype.hasOwnProperty.call(result, 'extracted')) {
    // Label the card by the type OCR was actually run under, not the type the row is stored as.
    // Two doc types differ: an address proof (DRIVING_LICENCE etc., chosen in a preceding question
    // and passed in as ocrDocType) and COMPANY_PAN (always read as a PAN, mapped statically by
    // registration.service.js). OCR_FIELD_LABELS has no entry for either stored caption, so
    // without this the card lists no fields at all - which is how COMPANY_PAN uploads came back
    // showing an empty extraction even though OCR had succeeded.
    const labelDocType = ocrDocType ?? OCR_TYPE_BY_DOC_TYPE[docType] ?? docType;

    if (result.extracted) {
      // Carry addressProofOcrType forward too - a "No, re-upload" answer resets the session back
      // to this same shape (see handle()'s pendingDocConfirmation branch), and without this the
      // second upload attempt loses its OCR type and silently skips extraction.
      typebotSessionStore.set(userId, {
        sessionId: session.sessionId,
        input: session.input,
        pendingDocConfirmation: { fileUrl },
        ...(session.addressProofOcrType !== undefined ? { addressProofOcrType: session.addressProofOcrType } : {}),
      });

      return {
        sessionEnded: false,
        messages: buildOcrConfirmationMessages(labelDocType, result.extracted),
        input: OCR_CONFIRM_CHOICE_INPUT,
        // OCR_CONFIRM_CHOICE_INPUT is a synthetic block, not a real flow id - the
        // user hasn't actually left the real upload question yet, so use its progress.
        progress: resolveProgress(session.input.id),
      };
    }

    // result.failureReason carries the OCR service's own message (e.g. a wrong-document-type or
    // low-confidence reason from ocr.choira.io) when runOcrAndPersist caught one - shown as-is, with
    // no generic line appended, since the OCR service's own wording already tells the member what to
    // do (e.g. "This looks like a cancelled cheque, not a PAN card. Please upload your PAN card.").
    // Falls back to the original generic wording only when there's no failureReason at all
    // (network/timeout failures, or older callers/tests that don't set it).
    return {
      sessionEnded: false,
      messages: [
        textMessage(
          'ocr-extraction-failed',
          result.failureReason
            ? `We couldn't verify this ${labelDocType} document:\n${result.failureReason}`
            : `We couldn't read this ${labelDocType} document clearly. Please upload a clearer, better-quality image.`,
        ),
      ],
      input: session.input,
      progress: resolveProgress(session.input.id),
    };
  }

  return handle({ userId, token, attachedFileUrls: [fileUrl] });
}
