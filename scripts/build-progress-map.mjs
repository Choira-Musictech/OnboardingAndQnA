// ==================================================================
// Regenerates src/modules/conversation/services/typebot/progressMap.js
// from the flow the backend runs (src/modules/conversation/flow/registrationFlow.json).
//
//   npm run build:progress-map
//
// WHY THIS EXISTS: the map used to be hand-traced, and it went stale the
// moment Studio was republished - it still described the previous bot
// (one role path, a `spotifyUrl` step no block uses) while the live flow
// had grown to 131 questions across four paths, so resolveProgress()
// returned null nearly everywhere. Hand-editing it would just start that
// clock again. Run this after any change to the flow file instead.
// ==================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPaymentStep,
  PAYMENT_BLOCK_IDS,
} from '../src/modules/conversation/services/typebot/paymentBlockIds.js';

const FLOW_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/modules/conversation/flow/registrationFlow.json',
);
const OUTPUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/modules/conversation/services/typebot/progressMap.js',
);

// Block types that actually stop and wait for the member. `text` and `Wait` pass straight through.
const INPUT_TYPES = new Set(['choice input', 'text input', 'file input', 'url input']);

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// --- load -----------------------------------------------------------------

function loadFlowFile() {
  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'));
  } catch (err) {
    fail(`Could not read ${FLOW_FILE}: ${err.message}`);
  }
  if (!flow?.groups?.length) fail('The flow file has no groups');
  return flow;
}

// --- graph ----------------------------------------------------------------

function buildGraph(flow) {
  const groupById = new Map(flow.groups.map((g) => [g.id, g]));
  const edgeById = new Map((flow.edges ?? []).map((e) => [e.id, e]));
  const blockById = new Map();
  const locationOf = new Map();

  for (const group of flow.groups) {
    (group.blocks ?? []).forEach((block, index) => {
      blockById.set(block.id, block);
      locationOf.set(block.id, { group, index });
    });
  }

  // An edge lands on a specific block, or on the target group's first block.
  const edgeTarget = (edgeId) => {
    const edge = edgeById.get(edgeId);
    if (!edge?.to) return null;
    return edge.to.blockId ?? groupById.get(edge.to.groupId)?.blocks?.[0]?.id ?? null;
  };

  // Choice items each carry their own edge; otherwise the block's own edge; otherwise fall through
  // to the next block in the group.
  const successors = (blockId) => {
    const block = blockById.get(blockId);
    const location = locationOf.get(blockId);
    if (!block || !location) return [];

    const out = [];
    for (const item of block.items ?? []) if (item.outgoingEdgeId) out.push(edgeTarget(item.outgoingEdgeId));
    if (block.outgoingEdgeId) out.push(edgeTarget(block.outgoingEdgeId));
    if (out.length === 0) {
      const next = location.group.blocks?.[location.index + 1];
      if (next) out.push(next.id);
    }
    return out.filter(Boolean);
  };

  // Walk past text/Wait blocks to the next questions the member will actually be asked.
  const nextInputs = (blockId) => {
    const found = new Set();
    const seen = new Set();
    const stack = [...successors(blockId)];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const block = blockById.get(id);
      if (!block) continue;
      if (INPUT_TYPES.has(block.type)) found.add(id);
      else stack.push(...successors(id));
    }
    return [...found];
  };

  return { blockById, successors, nextInputs, edgeTarget };
}

function computeProgress(flow, graph) {
  const { blockById, successors, nextInputs, edgeTarget } = graph;

  const startEdge = flow.events?.[0]?.outgoingEdgeId;
  const startBlock = startEdge ? edgeTarget(startEdge) : null;
  if (!startBlock) fail('Could not find the flow\'s start block');

  const reachable = new Set();
  {
    const seen = new Set();
    const stack = [startBlock];
    while (stack.length) {
      const id = stack.pop();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const block = blockById.get(id);
      if (!block) continue;
      if (INPUT_TYPES.has(block.type)) reachable.add(id);
      stack.push(...successors(id));
    }
  }

  // remaining = how many questions are still to come, worst case, counting this one.
  const remaining = new Map();
  const inProgress = new Set();
  const computeRemaining = (id) => {
    if (remaining.has(id)) return remaining.get(id);
    if (inProgress.has(id)) return 0; // a cycle: treat as terminal rather than looping forever
    inProgress.add(id);
    const downstream = nextInputs(id).map(computeRemaining);
    const value = 1 + (downstream.length ? Math.max(...downstream) : 0);
    inProgress.delete(id);
    remaining.set(id, value);
    return value;
  };
  for (const id of reachable) computeRemaining(id);

  // depth = the longest run of questions from the start to this one. `remaining` strictly decreases
  // along every edge, so descending `remaining` is a valid topological order and one pass suffices.
  const depth = new Map();
  const firstInputs = new Set(
    (() => {
      const found = [];
      const seen = new Set();
      const stack = [startBlock];
      while (stack.length) {
        const id = stack.pop();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const block = blockById.get(id);
        if (!block) continue;
        if (INPUT_TYPES.has(block.type)) found.push(id);
        else stack.push(...successors(id));
      }
      return found;
    })(),
  );
  for (const id of firstInputs) depth.set(id, 1);
  for (const id of [...reachable].sort((a, b) => remaining.get(b) - remaining.get(a))) {
    const d = depth.get(id) ?? 1;
    for (const next of nextInputs(id)) depth.set(next, Math.max(depth.get(next) ?? 1, d + 1));
  }

  // questions already answered / questions on this path. Per-block, so each role path reaches its
  // own end - a single global total can't work when paths run 26 to 34 questions.
  const percent = new Map();
  for (const id of reachable) {
    const d = depth.get(id) ?? 1;
    const r = remaining.get(id);
    percent.set(id, Math.round(((d - 1) / (d + r - 1)) * 100));
  }

  return { reachable, remaining, depth, percent };
}

// --- checks ---------------------------------------------------------------

// A broken flow must fail loudly here rather than shipping a map that quietly misreports progress.
function assertSane(flow, graph, { reachable, percent }) {
  const { blockById, nextInputs } = graph;

  const allInputs = [...blockById.values()].filter((b) => INPUT_TYPES.has(b.type));
  const orphans = allInputs.filter((b) => !reachable.has(b.id));
  if (orphans.length) {
    console.warn(`  warning: ${orphans.length} input block(s) are unreachable from the start and were skipped`);
  }

  const out_of_range = [...percent.values()].filter((p) => p < 0 || p > 99);
  if (out_of_range.length) fail(`${out_of_range.length} block(s) computed a percentage outside 0-99`);

  // The property that actually matters: progress must never move backwards, on any edge.
  let backwards = 0;
  for (const id of reachable) {
    for (const next of nextInputs(id)) {
      if (!percent.has(next) || next === id) continue;
      if (percent.get(next) < percent.get(id)) {
        if (backwards < 5) console.error(`    ${id} (${percent.get(id)}%) -> ${next} (${percent.get(next)}%)`);
        backwards += 1;
      }
    }
  }
  if (backwards) fail(`progress moves backwards on ${backwards} edge(s) - the map would be wrong`);

  // Matched against paymentGate.js's own block ids, not the button's label. This used to test the
  // label with /^pay(ment)?$/i, which stopped matching the moment it was renamed to "Pay Application
  // Fee" - the check then silently reported zero payment blocks instead of verifying anything.
  const payments = allInputs.filter((b) => isPaymentStep(b.id));
  const unresolved = payments.filter((b) => !percent.has(b.id));
  if (payments.length !== PAYMENT_BLOCK_IDS.size) {
    fail(
      `expected ${PAYMENT_BLOCK_IDS.size} payment blocks in the flow, found ${payments.length} - ` +
        'a republish has changed their block ids, so paymentGate.js is now unreachable. ' +
        'Re-fetch the ids and update src/modules/conversation/services/typebot/paymentBlockIds.js.',
    );
  }
  if (unresolved.length) fail(`${unresolved.length} payment block(s) did not resolve to a percentage`);

  return { inputs: allInputs.length, payments: payments.length };
}

// --- emit -----------------------------------------------------------------

function label(flow, block) {
  const names = Object.fromEntries((flow.variables ?? []).map((v) => [v.id, v.name]));
  const variableId = block.options?.variableId;
  const raw = variableId
    ? names[variableId] ?? variableId
    : block.items?.[0]?.content ?? block.type;
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 42);
}

function render(flow, graph, { percent }) {
  const { blockById } = graph;

  // Sorted by percentage then id: stable across runs, and the file reads in flow order.
  const entries = [...percent.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([id, value]) => {
      const block = blockById.get(id);
      return `  ${id}: ${String(value).padStart(3)}, // ${block.type.padEnd(12)} ${label(flow, block)}`;
    });

  return `// ==================================================================
// GENERATED FILE - do not edit by hand.
//   npm run build:progress-map
// Re-run it after every Studio republish. See scripts/build-progress-map.mjs.
//
// Typebot's Chat API never returns a \`progress\` field (confirmed live -
// startChat/continueChat responses only ever carry sessionId/resultId/
// typebot/messages/input/clientSideActions/logs; Studio's "Enable
// progress bar" toggle only affects Typebot's own embed widget, not the
// API). This backend drives the conversation by API relay, not the
// embed, so progress has to be computed here.
//
// Each value is "questions already answered / questions on this path",
// computed per block from the published flow's graph. It is NOT measured
// against a single global step count: the four role paths run 26 to 34
// questions, and one shared total would leave the short paths stuck
// below 100% forever.
//
// Nothing here reaches 100 on purpose - registrationEngine.handle()
// forces 100 when the session actually ends, and while the payment
// button is still on screen the member hasn't finished.
//
// Verified at generation time: progress never decreases along any edge.
// ==================================================================
const PROGRESS_BY_BLOCK = {
${entries.join('\n')}
};

// null for an unknown block - the caller passes that straight through, so a block added in Studio
// before this map is regenerated shows no progress rather than a wrong one.
export function resolveProgress(blockId) {
  return PROGRESS_BY_BLOCK[blockId] ?? null;
}
`;
}

// --- main -----------------------------------------------------------------

const flow = loadFlowFile();
const graph = buildGraph(flow);
const computed = computeProgress(flow, graph);
const stats = assertSane(flow, graph, computed);

fs.writeFileSync(OUTPUT, render(flow, graph, computed));

console.log(`  groups ${flow.groups.length}  edges ${(flow.edges ?? []).length}`);
console.log(`  questions mapped: ${computed.percent.size} of ${stats.inputs}  (payment blocks: ${stats.payments})`);
console.log(`  wrote ${path.relative(process.cwd(), OUTPUT)}`);
