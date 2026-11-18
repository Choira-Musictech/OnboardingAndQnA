// ==================================================================
// The onboarding flow run inside the backend (flowEngine.js) - no Typebot server.
// Runs the real flow file (src/modules/conversation/flow/registrationFlow.json). No DB, no network.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlowEngine, RETRY_MESSAGE } from '../src/modules/conversation/services/flow/flowEngine.js';
import { isDeadSessionError } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { PAYMENT_BLOCK_IDS } from '../src/modules/conversation/services/typebot/paymentBlockIds.js';
import { resolveProgress } from '../src/modules/conversation/services/typebot/progressMap.js';

const textOf = (message) =>
  JSON.stringify(message.content.richText)
    .match(/"text":"((?:[^"\\]|\\.)*)"/g)
    ?.map((m) => JSON.parse(m.slice(7)))
    .join('') ?? '';

const answerFor = (input) => {
  switch (input.type) {
    case 'text input':
      return { type: 'text', text: 'Test answer' };
    case 'url input':
      return { type: 'text', text: 'https://youtu.be/BBAyRBTfsOU' };
    case 'file input':
      return { type: 'text', text: 'https://api.example/uploads/abc/pan.jpg', attachedFileUrls: ['https://api.example/uploads/abc/pan.jpg'] };
    default:
      return { type: 'text', text: input.items[0].content };
  }
};

test('the first response is the greeting and the "become a member" button, like Typebot sent', async () => {
  const engine = createFlowEngine();
  const res = await engine.startChat({ prefilledVariables: { token: 't', registrationId: '1' } });

  assert.ok(res.sessionId);
  assert.deepEqual(res.messages.map(textOf), [
    'Hello! I am your IPRS assistant.',
    'I help musicians join IPRS so you get paid when your songs are played. Do you want to become an IPRS member? ',
  ]);
  assert.equal(res.messages[0].type, 'text');
  assert.equal(res.messages[0].content.type, 'richText');
  assert.equal(res.input.id, 'tebp7htyvolml8wokttg66pw');
  assert.equal(res.input.type, 'choice input');
  assert.deepEqual(res.input.items.map((i) => i.content), ['Yes, I want to become a member']);
  assert.equal(res.input.outgoingEdgeId, undefined, 'routing is not handed out');
  assert.equal(res.input.items[0].outgoingEdgeId, undefined);
});

test('a button answer follows its own branch; continueChat does not repeat the sessionId', async () => {
  const engine = createFlowEngine();
  const { sessionId } = await engine.startChat();
  const path = await engine.continueChat({ sessionId, message: { type: 'text', text: 'Yes, I want to become a member' } });

  assert.equal(path.sessionId, undefined);
  assert.equal(path.input.id, 'ofaqjfre4b6smht07inyag0w');
  assert.match(textOf(path.messages[0]), /Are you joining as an Author \/ Composer or Owner Publisher/);

  // Matched by label, ignoring case and spaces - the chat sends the button's label text.
  const role = await engine.continueChat({ sessionId, message: { type: 'text', text: '  (individual) author / composer ' } });
  assert.equal(role.input.id, 'qvo8thfagkj2mixdoj382da4');
  assert.match(textOf(role.messages[0]), /What is your role in the music/);
});

test('Wait blocks are passed straight through', async () => {
  const engine = createFlowEngine();
  const { sessionId } = await engine.startChat();
  await engine.continueChat({ sessionId, message: { type: 'text', text: 'Yes, I want to become a member' } });
  await engine.continueChat({ sessionId, message: { type: 'text', text: '(Individual) Author / Composer' } });
  const next = await engine.continueChat({ sessionId, message: { type: 'text', text: 'Composer' } });

  // The "Requirements for Author/Composer (Individual)" text, then (past a 10 s Wait group) the next question.
  assert.match(textOf(next.messages[0]), /Requirements for Author\/Composer \(Individual\)/);
  assert.ok(next.input, 'the member lands on the next question, not on the Wait');
});

test('an answer the question cannot take comes back as the same question with Typebot\'s retry message', async () => {
  const engine = createFlowEngine();
  const { sessionId } = await engine.startChat();
  const res = await engine.continueChat({ sessionId, message: { type: 'text', text: 'maybe later' } });

  assert.equal(res.input.id, 'tebp7htyvolml8wokttg66pw');
  assert.equal(textOf(res.messages[0]), RETRY_MESSAGE);
  // Still on that question: the right answer works afterwards.
  const ok = await engine.continueChat({ sessionId, message: { type: 'text', text: 'Yes, I want to become a member' } });
  assert.equal(ok.input.id, 'ofaqjfre4b6smht07inyag0w');
});

test('text, link and file questions check the answer', async () => {
  const engine = createFlowEngine();
  const inputOf = (type) => [...engine._flow.blocks.values()].find(({ block }) => block.type === type).block;
  const ask = async (block, message) => {
    const { sessionId } = await engine.startChat();
    engine._sessions.get(sessionId).blockId = block.id;
    return engine.continueChat({ sessionId, message });
  };

  const text = inputOf('text input');
  assert.equal((await ask(text, { type: 'text', text: '   ' })).input.id, text.id, 'blank text is refused');
  assert.notEqual((await ask(text, { type: 'text', text: 'Mumbai' })).input?.id, text.id);

  const url = inputOf('url input');
  assert.equal((await ask(url, { type: 'text', text: 'not a link' })).input.id, url.id);
  assert.equal((await ask(url, { type: 'text', text: 'javascript:alert(1)' })).input.id, url.id);
  assert.notEqual((await ask(url, { type: 'text', text: 'https://youtu.be/BBAyRBTfsOU' })).input?.id, url.id);

  const file = inputOf('file input');
  assert.equal((await ask(file, { type: 'text', text: '' })).input.id, file.id);
  assert.notEqual((await ask(file, answerFor(file))).input?.id, file.id);
});

test('a session the engine does not know is a dead session, so the chat restarts and resumes', async () => {
  const engine = createFlowEngine();
  await assert.rejects(engine.continueChat({ sessionId: 'gone', message: { type: 'text', text: 'x' } }), (err) => isDeadSessionError(err));
});

test('an idle session expires', async () => {
  let clock = 1_000;
  const engine = createFlowEngine({ now: () => clock, idleMs: 60_000 });
  const { sessionId } = await engine.startChat();
  clock += 61_000;
  await engine.startChat(); // any later start prunes idle sessions
  await assert.rejects(engine.continueChat({ sessionId, message: { type: 'text', text: 'x' } }), (err) => isDeadSessionError(err));
});

test('every question is reachable, every path ends at a Pay button, and only there', async () => {
  const engine = createFlowEngine();
  const start = await engine.startChat();
  const seen = new Set();
  const ends = new Set();
  const queue = [start.input];

  while (queue.length) {
    const input = queue.shift();
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    const answers = input.type === 'choice input' ? input.items.map((item) => ({ type: 'text', text: item.content })) : [answerFor(input)];
    for (const message of answers) {
      const { sessionId } = await engine.startChat();
      engine._sessions.get(sessionId).blockId = input.id;
      const next = await engine.continueChat({ sessionId, message });
      if (!next.input) {
        ends.add(input.id);
        continue;
      }
      assert.notEqual(next.input.id, input.id, `answering ${input.id} must move on`);
      queue.push(next.input);
    }
  }

  assert.deepEqual([...ends].sort(), [...PAYMENT_BLOCK_IDS].sort(), 'the flow only ends at the Pay buttons');
  const allInputs = [...engine._flow.blocks.values()].filter(({ block }) => /input$/.test(block.type));
  assert.equal(seen.size, allInputs.length, 'every question in the flow can be reached');
  for (const id of seen) assert.notEqual(resolveProgress(id), null, `progressMap knows ${id}`);
});
