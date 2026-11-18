// ==================================================================
// Runs the onboarding flow inside the backend - no Typebot server.
//
// The flow is the Typebot export in ../../flow/registrationFlow.json, run as-is: the same block ids,
// variable ids, wording and buttons, and the same Chat API response shapes Typebot sent
// ({ sessionId, messages, input }). Everything keyed by those ids - the gates, the journal and
// resume, progressMap.js, the payment detection, the frontend - keeps working unchanged. To change a
// question, edit that file (or drop in a fresh export) and run `npm run build:progress-map`.
//
// The flow only uses text, choice, text input, file input, url input and Wait blocks; branching comes
// from choice buttons alone (no conditions, variables are only stored). Navigation follows
// block.outgoingEdgeId / item.outgoingEdgeId and never searches `edges[]` for a source block - the
// export carries stale edges whose source no longer exists.
// ==================================================================
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appError } from '../../../../shared/errors.js';

const FLOW_PATH = new URL('../../flow/registrationFlow.json', import.meta.url);

const INPUT_TYPES = new Set(['choice input', 'text input', 'file input', 'url input']);

// Typebot's own reply to an answer it would not accept - kept word for word: the engine reads "the
// same input came back" as a rejection, and flow-translations.json already translates this text.
export const RETRY_MESSAGE = 'Invalid message. Please, try again.';

// An idle chat is dropped after this long. The next answer then gets "session not found", which the
// engine already treats as an expired chat (a fresh start plus the journal to resume from).
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;

export function loadFlow(source = JSON.parse(readFileSync(FLOW_PATH, 'utf8'))) {
  const blocks = new Map();
  const groups = new Map();
  for (const group of source.groups ?? []) {
    groups.set(group.id, group);
    group.blocks.forEach((block, index) => blocks.set(block.id, { block, group, index }));
  }
  const edges = new Map((source.edges ?? []).map((edge) => [edge.id, edge]));
  const startEvent = (source.events ?? []).find((event) => event.type === 'start') ?? source.events?.[0];
  if (!startEvent?.outgoingEdgeId) throw new Error('The flow has no start event');
  return { blocks, groups, edges, startEdgeId: startEvent.outgoingEdgeId };
}

const textOf = (value) => String(value ?? '').trim();

function retryResponse(input) {
  return {
    messages: [{ id: crypto.randomUUID(), type: 'text', content: { type: 'richText', richText: [{ type: 'p', children: [{ text: RETRY_MESSAGE }] }] } }],
    input,
  };
}

export function createFlowEngine({ flow = loadFlow(), now = Date.now, idleMs = SESSION_IDLE_MS } = {}) {
  const sessions = new Map();

  function sessionNotFound() {
    // Same shape the old Typebot client threw, so isDeadSessionError() and every caller that
    // recovers from an expired chat keep working.
    return appError('Session not found.', { statusCode: 404, errorCode: 'TYPEBOT_REQUEST_FAILED' });
  }

  function prune() {
    const cutoff = now() - idleMs;
    for (const [id, session] of sessions) {
      if (session.touchedAt < cutoff) sessions.delete(id);
    }
    // Still too many: drop the oldest. A dropped member resumes from the journal like an expired one.
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
      for (const [id] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
    }
  }

  // The input block as Typebot's Chat API sent it: its own fields, without the routing.
  function toInput(block) {
    const { outgoingEdgeId, ...rest } = block;
    const input = { ...rest, options: { ...(block.options ?? {}) } };
    if (Array.isArray(block.items)) {
      input.items = block.items.map(({ outgoingEdgeId: _edge, ...item }) => item);
    }
    return input;
  }

  function toMessage(block) {
    return { id: block.id, type: 'text', content: { type: 'richText', richText: block.content?.richText ?? [] } };
  }

  // Where an edge leads: the block it names, or the first block of its group.
  function targetOf(edgeId) {
    const edge = edgeId ? flow.edges.get(edgeId) : null;
    if (!edge?.to?.groupId) return null;
    const group = flow.groups.get(edge.to.groupId);
    if (!group?.blocks?.length) return null;
    const index = edge.to.blockId ? group.blocks.findIndex((b) => b.id === edge.to.blockId) : 0;
    return { group, index: Math.max(index, 0) };
  }

  // Runs blocks from `position` until the next input (or the end of the flow), collecting what the
  // member is shown on the way.
  function walk(position) {
    const messages = [];
    let at = position;
    const seen = new Set();
    while (at) {
      const block = at.group.blocks[at.index];
      if (!block) break;
      // A flow that loops on itself without asking anything would never return.
      if (seen.has(block.id)) throw appError('The registration flow loops without a question', { errorCode: 'FLOW_INVALID' });
      seen.add(block.id);

      if (INPUT_TYPES.has(block.type)) return { messages, input: block };
      if (block.type === 'text') messages.push(toMessage(block));
      // Wait blocks are skipped: the chat never paused on them (the old client ignored Typebot's wait action).

      if (block.outgoingEdgeId) {
        at = targetOf(block.outgoingEdgeId);
      } else if (at.index + 1 < at.group.blocks.length) {
        at = { group: at.group, index: at.index + 1 };
      } else {
        at = null;
      }
    }
    return { messages, input: null };
  }

  // The edge an accepted answer follows, or undefined when the answer is not acceptable.
  function acceptAnswer(block, message) {
    const text = textOf(message?.text);
    switch (block.type) {
      case 'choice input': {
        const chosen = (block.items ?? []).find((item) => textOf(item.content).toLowerCase() === text.toLowerCase());
        if (!chosen) return undefined;
        return { value: textOf(chosen.content), edgeId: chosen.outgoingEdgeId ?? block.outgoingEdgeId ?? null };
      }
      case 'text input':
        return text ? { value: text, edgeId: block.outgoingEdgeId ?? null } : undefined;
      case 'url input': {
        try {
          const url = new URL(text);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        } catch {
          return undefined;
        }
        return { value: text, edgeId: block.outgoingEdgeId ?? null };
      }
      case 'file input': {
        const urls = (message?.attachedFileUrls ?? []).filter(Boolean);
        const value = urls.length ? urls.join(', ') : text;
        return value ? { value, edgeId: block.outgoingEdgeId ?? null } : undefined;
      }
      default:
        return undefined;
    }
  }

  function respond(sessionId, session, { messages, input }) {
    if (input) {
      session.blockId = input.id;
      session.touchedAt = now();
    } else {
      sessions.delete(sessionId);
    }
    return { sessionId, messages, input: input ? toInput(input) : null };
  }

  async function startChat({ prefilledVariables } = {}) {
    prune();
    const sessionId = crypto.randomUUID();
    const session = { blockId: null, variables: { ...(prefilledVariables ?? {}) }, touchedAt: now() };
    sessions.set(sessionId, session);
    return respond(sessionId, session, walk(targetOf(flow.startEdgeId)));
  }

  async function continueChat({ sessionId, message }) {
    const session = sessions.get(sessionId);
    if (!session) throw sessionNotFound();
    const current = flow.blocks.get(session.blockId)?.block;
    if (!current) {
      sessions.delete(sessionId);
      throw sessionNotFound();
    }

    const accepted = acceptAnswer(current, message);
    session.touchedAt = now();
    if (!accepted) {
      const { messages, input } = retryResponse(toInput(current));
      return { messages, input };
    }

    if (current.options?.variableId) session.variables[current.options.variableId] = accepted.value;
    const next = walk(targetOf(accepted.edgeId));
    const { messages, input } = respond(sessionId, session, next);
    // continueChat responses never repeated the sessionId (the engine reads it from startChat only).
    return { messages, input };
  }

  /** True while this session is live - lets uploads refuse a session that does not exist. */
  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  return { startChat, continueChat, hasSession, _sessions: sessions, _flow: flow };
}

export const flowEngine = createFlowEngine();
