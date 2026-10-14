// ==================================================================
// The mother-tongue step takes only a language from IPRS's list (node:test).
//
// A label from the picker is saved with its LanguageId and relayed to Typebot; anything that is not
// in the list is asked again and never relayed. The Typebot client, journal, field save and the
// language table are all stubbed - no network, no database. Run: npm test
// ==================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { conversationJournalService } from '../src/modules/conversation/services/conversationJournal.service.js';
import { MOTHER_TONGUE_VARIABLE_ID } from '../src/modules/conversation/services/typebot/languageGate.js';
import { registrationService } from '../src/modules/registration/services/registration.service.js';
import { languageLookupService } from '../src/modules/registration/services/languageLookup.service.js';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';

const USER = '999997';
const MOTHER_TONGUE_INPUT = { id: 'mother-tongue-block', type: 'text input', options: { variableId: MOTHER_TONGUE_VARIABLE_ID } };

let relayed;
let saved;

beforeEach(() => {
  relayed = [];
  saved = [];
  languageLookupService.resetLanguageCache();
  prisma.appLanguageLookup.findMany = async () => [
    { LanguageId: 59n, LanguageName: 'Hindi', NativeName: 'हिन्दी, हिंदी' },
    { LanguageId: 19n, LanguageName: 'Bengali', NativeName: 'বাংলা' },
  ];
  typebotClient.continueChat = async ({ message }) => {
    relayed.push(message?.text);
    return { messages: [], input: { id: 'next-block', type: 'text input', options: {} } };
  };
  registrationService.saveConversationField = async (...args) => { saved.push(args.slice(2)); };
  conversationJournalService.recordTurn = async () => {};
  typebotSessionStore.set(USER, { sessionId: 'fake-session', input: MOTHER_TONGUE_INPUT });
});

const say = (message) => handle({ userId: USER, token: 'test-token', message });

test('a label from the picker is relayed to Typebot and saved as the member\'s mother tongue', async () => {
  const reply = await say('Hindi(हिन्दी)');

  assert.deepEqual(relayed, ['Hindi(हिन्दी)']);
  assert.deepEqual(saved, [['LanguageName', 'Hindi(हिन्दी)']]);
  assert.equal(reply.input.id, 'next-block');
});

test('a language that is not in the list is asked again and is not relayed or saved', async () => {
  const reply = await say('Bhojpuri');

  assert.deepEqual(relayed, []);
  assert.deepEqual(saved, []);
  assert.equal(reply.input.id, MOTHER_TONGUE_INPUT.id, 'the member stays on the same question');
  assert.match(JSON.stringify(reply.messages), /choose your mother tongue from the list/);
});

test('a half-typed label that matches nothing is asked again', async () => {
  const reply = await say('Hindi(हिन्');

  assert.deepEqual(relayed, []);
  assert.equal(reply.input.id, MOTHER_TONGUE_INPUT.id);
});

test('other questions are not affected by the gate', async () => {
  typebotSessionStore.set(USER, {
    sessionId: 'fake-session',
    input: { id: 'place-block', type: 'text input', options: { variableId: 'vy80zc5eoveac6euqlurki58o' } },
  });
  const reply = await say('Mumbai');

  assert.deepEqual(relayed, ['Mumbai']);
  assert.equal(reply.input.id, 'next-block');
});
