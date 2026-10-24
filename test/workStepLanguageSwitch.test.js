// ==================================================================
// A language switch in the middle of the work-link step (node:test).
//
// The step's own questions are asked by the backend, not Typebot, so what the member is in the middle
// of lives only in the in-memory session. A language switch replays the journal into a NEW Typebot
// session, which lands on the plain "share a link" question - these tests pin that the song, its
// details and the question the member was on come back, and that a member who already saved a link
// is offered "No, move on". Everything stubbed - no database, no Typebot. Run: npm test
// ==================================================================
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { conversationJournalService, REPLAY_STOP } from '../src/modules/conversation/services/conversationJournal.service.js';
import { workLinkService } from '../src/modules/work/services/workLink.service.js';
import { registrationService } from '../src/modules/registration/services/registration.service.js';
import { WORK_URL_VARIABLE_ID } from '../src/modules/conversation/services/typebot/workLinkGate.js';

const USER = '991001';
const URL_INPUT = { id: 'work-url-block', type: 'url input', options: { variableId: WORK_URL_VARIABLE_ID } };
const bubble = (id, text) => ({ id, type: 'text', content: { type: 'richText', richText: [{ type: 'p', children: [{ text }] }] } });
const text = (entry) => entry?.content?.richText?.[0]?.children?.[0]?.text ?? '';
const texts = (res) => (res.messages ?? []).map(text).join(' || ');

const SONG_URL = 'https://open.spotify.com/track/abc';
const savedSong = { WorkNotificationId: 7, DigitalLink: SONG_URL, SongName: 'Samjhawan', Film_AlbumName: null, Publisher: 'Sony Music', WorkCategory: null, LanguageNames: null, ReleaseYear: null };

const real = {};
let savedRows = [];

beforeEach(() => {
  savedRows = [];
  real.start = typebotClient.startChat;
  real.count = conversationJournalService.countTurns;
  real.load = conversationJournalService.loadJournal;
  real.replay = conversationJournalService.replayJournal;
  real.rows = workLinkService.getWorkLinks;
  real.names = registrationService.getIdentityNames;

  typebotClient.startChat = async () => ({ sessionId: 'new-session', messages: [], input: URL_INPUT });
  conversationJournalService.countTurns = async () => 3;
  conversationJournalService.loadJournal = async () => [];
  conversationJournalService.replayJournal = async () => ({
    response: { input: URL_INPUT, messages: [bubble('link-prompt', 'Please share a link to your work.')] },
    replayed: 0,
    askedInputs: [],
    stop: REPLAY_STOP.COMPLETE,
    transcript: [],
  });
  workLinkService.getWorkLinks = async () => savedRows;
  registrationService.getIdentityNames = async () => ({ trusted: [], claimed: [], roleLabels: ['Composer'], isPublisher: false });
});

afterEach(() => {
  typebotClient.startChat = real.start;
  conversationJournalService.countTurns = real.count;
  conversationJournalService.loadJournal = real.load;
  conversationJournalService.replayJournal = real.replay;
  workLinkService.getWorkLinks = real.rows;
  registrationService.getIdentityNames = real.names;
  typebotSessionStore.clear(USER);
});

const switchLanguage = () => handle({ userId: USER, token: 't', relocalize: true });
const pending = (state) => typebotSessionStore.set(USER, { sessionId: 'old-session', input: URL_INPUT, ...state });

test('switching language at a song details question keeps the song and the question', async () => {
  savedRows = [savedSong];
  const queue = [{ field: 'Film_AlbumName', workNotificationId: 7 }, { field: 'WorkCategory', workNotificationId: 7 }];
  pending({ pendingWorkRowDetails: { queue, index: 0, lastUrl: SONG_URL, atCap: false, saved: "Saved - that's 1 of 5 links." } });

  const res = await switchLanguage();

  assert.notEqual(res.input?.id, URL_INPUT.id, 'not the bare link question');
  assert.match(texts(res), /Song details saved\n\nSong: Samjhawan\nPublisher: Sony Music/);
  assert.match(texts(res), /film or album/i, 'the same question again');
  assert.ok(res.history.some((e) => e.sender === 'user' && e.answer === SONG_URL), 'the link the member pasted is shown');
  // The pending state is back, so answering carries on exactly where it was.
  const session = typebotSessionStore.get(USER);
  assert.equal(session.sessionId, 'new-session');
  assert.equal(session.pendingWorkRowDetails.index, 0);
});

test('switching language at "is this your song?" shows the song and the question again', async () => {
  const resolved = { url: SONG_URL, provider: 'spotify', songName: 'Samjhawan', artists: ['Arijit Singh'], composers: ['Toshi Sabri'], lyricists: ['Kumaar'], publisher: 'Sony Music' };
  pending({ pendingWorkLinkConfirm: { resolved } });

  const res = await switchLanguage();

  assert.equal(res.input?.id, 'work-link-confirm');
  assert.match(texts(res), /Song: Samjhawan[\s\S]*Publisher: Sony Music[\s\S]*Is this your song\?/);
  assert.ok(typebotSessionStore.get(USER).pendingWorkLinkConfirm, 'still waiting for the answer');
});

test('switching language at "add another?" keeps the question', async () => {
  savedRows = [savedSong];
  pending({ pendingWorkLinkChoice: { lastUrl: SONG_URL } });

  const res = await switchLanguage();

  assert.equal(res.input?.id, 'work-link-add-another');
  assert.match(texts(res), /1 of 5 links\. Would you like to add another\?/);
});

test('a link already saved and no step in progress: the link question offers "No, move on"', async () => {
  savedRows = [{ ...savedSong, DigitalLink: 'https://youtu.be/first' }, savedSong];

  const res = await switchLanguage();

  assert.equal(res.input?.id, URL_INPUT.id, 'still the link question');
  assert.deepEqual(res.input.items.map((i) => i.content), ['No, move on']);
  // "No, move on" is handled by the duplicate branch, which replays the latest saved link.
  assert.deepEqual(typebotSessionStore.get(USER).pendingWorkLinkDuplicate, { url: SONG_URL });
});

test('no link saved yet: the link question is left as it is, with no move-on button', async () => {
  const res = await switchLanguage();

  assert.equal(res.input?.id, URL_INPUT.id);
  assert.equal(res.input.items, undefined);
  assert.match(texts(res), /share a link to your work/i);
});

test('when the saved songs cannot be read, the link question is served as before', async () => {
  workLinkService.getWorkLinks = async () => {
    throw new Error('table missing');
  };

  const res = await switchLanguage();

  assert.equal(res.input?.id, URL_INPUT.id);
  assert.equal(res.input.items, undefined);
});
