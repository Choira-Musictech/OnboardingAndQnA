// ==================================================================
// Resuming an abandoned registration.
//
// THE PROBLEM: the flow asks 30-odd questions and several document
// uploads. Leaving to find a PAN card or scan a passbook is normal
// behaviour, but `typebotSessionStore` is in-memory (no TTL, gone on
// restart) and Typebot drops its own session after ~20 minutes idle, so
// a member who comes back is sent to question 1.
//
// WHY REPLAY AND NOT A CURSOR: Typebot has no resume-at-block API for a
// public chat. Verified live - `startFrom: { type: 'group', groupId }`
// is accepted but SILENTLY IGNORED by
// /api/v1/typebots/{publicId}/startChat (identical response, question
// 1). It works only on /preview/, which serves the DRAFT flow, so
// returning members would get whatever half-finished edit is open in
// Studio. So instead a fresh session is opened on the published flow and
// the member's own answers are fed back in - verified to land on the
// identical block id, file uploads included (a presigned URL minted for
// the old session is still accepted by a new one).
//
// WHY A JOURNAL AND NOT THE EXISTING COLUMNS: 38 of the flow's 131
// inputs have no variableId at all - pure navigation choices that decide
// which branch the member is on and are stored nowhere. Without them the
// path cannot be reproduced.
//
// REPLAY DELIBERATELY BYPASSES registrationEngine.handle(), talking
// straight to typebotClient. Every gate (email OTP, work link, OCR
// confirmation, payment review) lives inside handle(), and they have all
// already run for these answers: re-entering them would re-send OTPs,
// re-charge the Spotify/YouTube lookups and re-save work links against
// the 5-link cap.
// ==================================================================
import { conversationJournalRepository } from '../repositories/conversationJournal.repository.js';
import { typebotClient } from './typebot/typebotClient.js';
import { logger } from '../../../utils/logger.js';

// A runaway replay would hammer Typebot on every message. The flow is ~34 questions on its longest
// path, so this is generous headroom rather than a real limit - hitting it means something is wrong.
export const MAX_REPLAY_TURNS = 80;

// Why a replay stopped. The member sees a different message for each, and `DIVERGED` is the one
// worth logging: it means the published flow changed under a stored journal.
export const REPLAY_STOP = Object.freeze({
  COMPLETE: 'complete', // journal exhausted - the member is exactly where they left off
  DIVERGED: 'diverged', // the flow no longer asks what the journal recorded
  ENDED: 'ended', // the flow ran out of questions during replay
  CAPPED: 'capped', // MAX_REPLAY_TURNS hit
  FAILED: 'failed', // Typebot errored mid-replay
});

function toAttachedUrls(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    // A malformed row must not take the whole replay down - the answer text alone is usually
    // enough, since Typebot's own widget puts the file URL in `text` as well.
    return null;
  }
}

async function loadJournal(userId) {
  const rows = await conversationJournalRepository.findByAccountId(userId);
  return rows.map((row) => ({
    turnIndex: row.TurnIndex,
    blockId: row.BlockId,
    variableId: row.VariableId,
    answer: row.Answer ?? '',
    attachedFileUrls: toAttachedUrls(row.AttachedUrls),
  }));
}

async function countTurns(userId) {
  return conversationJournalRepository.countByAccountId(userId);
}

// The block the member was last asked about, so the caller can turn it into a progress percentage.
async function lastBlockId(userId) {
  const rows = await conversationJournalRepository.findByAccountId(userId);
  return rows.length ? rows[rows.length - 1].BlockId : null;
}

// Records one accepted answer. Never throws: a journal write failing must not cost the member the
// turn they just completed - they simply lose the ability to resume past this point.
//
// `accepted` is the caller's decision, not ours, because only the caller can see both the question
// that was asked and the one that came back. Typebot answers a rejected input with 200 and the SAME
// input repeated, so an unchecked write would journal "Invalid message" turns and replay a member
// into a loop.
async function recordTurn({ userId, blockId, variableId, answer, attachedFileUrls }) {
  if (!userId || !blockId) return null;

  try {
    const TurnIndex = await conversationJournalRepository.nextTurnIndex(userId);
    return await conversationJournalRepository.createTurn({
      AccountId: BigInt(userId),
      TurnIndex,
      BlockId: String(blockId).slice(0, 50),
      VariableId: variableId ? String(variableId).slice(0, 50) : null,
      Answer: typeof answer === 'string' ? answer : null,
      AttachedUrls: attachedFileUrls?.length ? JSON.stringify(attachedFileUrls) : null,
    });
  } catch (err) {
    logger.warn({ userId, blockId, err }, 'Failed to journal a conversation turn - resume will stop here');
    return null;
  }
}

async function clearJournal(userId) {
  try {
    return await conversationJournalRepository.deleteByAccountId(userId);
  } catch (err) {
    logger.warn({ userId, err }, 'Failed to clear the conversation journal');
    return null;
  }
}

// Called after a replay that stopped short. The turns beyond that point answer questions the member
// is no longer on, and the next resume would replay them faithfully into the wrong branch - so the
// journal is cut back to what was actually re-established.
async function truncateAfterReplay(userId, replayed) {
  try {
    return await conversationJournalRepository.deleteFromTurnIndex(userId, replayed);
  } catch (err) {
    logger.warn({ userId, replayed, err }, 'Failed to truncate the journal after a short replay');
    return null;
  }
}

// Feeds a journal into a session that has just been started, and returns wherever that leaves the
// conversation. `startResponse` is the live startChat response - replay begins from whatever it is
// already asking, so a journal whose very first turn no longer matches diverges immediately rather
// than answering the wrong question.
async function replayJournal({ sessionId, startResponse, turns }) {
  let response = startResponse;
  let replayed = 0;

  for (const turn of turns) {
    if (replayed >= MAX_REPLAY_TURNS) return { response, replayed, stop: REPLAY_STOP.CAPPED };
    if (!response.input) return { response, replayed, stop: REPLAY_STOP.ENDED };

    // The guard that makes a republished flow safe. Sending a stored answer to a question it was
    // not given to is how a member ends up on the wrong branch with plausible-looking data - for a
    // rights society that is worse than making them re-answer.
    if (response.input.id !== turn.blockId) {
      logger.info(
        { sessionId, expected: turn.blockId, actual: response.input.id, turnIndex: turn.turnIndex },
        'Journal no longer matches the published flow - resuming from the divergence point',
      );
      return { response, replayed, stop: REPLAY_STOP.DIVERGED };
    }

    try {
      response = await typebotClient.continueChat({
        sessionId,
        message: { type: 'text', text: turn.answer, attachedFileUrls: turn.attachedFileUrls ?? undefined },
      });
    } catch (err) {
      // Half a replay is still progress - hand back whatever we reached rather than dropping the
      // member at question 1.
      logger.warn({ sessionId, turnIndex: turn.turnIndex, err }, 'Replay failed mid-journal');
      return { response, replayed, stop: REPLAY_STOP.FAILED };
    }
    replayed += 1;
  }

  return { response, replayed, stop: REPLAY_STOP.COMPLETE };
}

export const conversationJournalService = {
  loadJournal,
  countTurns,
  lastBlockId,
  recordTurn,
  clearJournal,
  truncateAfterReplay,
  replayJournal,
  MAX_REPLAY_TURNS,
  REPLAY_STOP,
};
