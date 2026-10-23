// ==================================================================
// Owner/Publisher members at the work-link step (node:test).
//
// A company is not a writer, so it is matched on the song's PUBLISHER: its official name and trader
// name against the label on the release. A song that names none is asked about; a mismatch asks
// for a trader name that does match (a claimed name, bounded like the writers' alias step), and a
// member is never stuck.
//
// Layers: the name rules (pure), the questions' translations (pure), and the flow through handle()
// from the "is this your song?" state, like workLink.test.js (needs SQL Server, skipped when it is
// unreachable). Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.TRANSLATION_ENABLED = 'true';
process.env.TRANSLATION_PROVIDER = 'dictionary';
process.env.TRANSLATION_DICTIONARY_PATH = fileURLToPath(new URL('../translations/flow-translations.json', import.meta.url));

const { prisma } = await import('../src/shared/prisma.js');
const { typebotSessionStore } = await import('../src/modules/conversation/services/typebot/typebotSessionStore.js');
const { handle } = await import('../src/modules/conversation/engines/registrationEngine.js');
const { workLinkService } = await import('../src/modules/work/services/workLink.service.js');
const { matchPublisher, MATCH_TRUST } = await import('../src/modules/work/services/workMatch.service.js');
const { WORK_URL_VARIABLE_ID, MAX_ALIAS_ATTEMPTS, describePublisherAsk, describePublisherMismatch, describePublisherRetry } =
  await import('../src/modules/conversation/services/typebot/workLinkGate.js');
const { dictionaryTranslate } = await import('../src/modules/translation/dictionary.js');

// --- the name rules (pure) -------------------------------------------------

test('a company matches its publisher however the legal form is spelt', () => {
  const same = (publisher, name) => matchPublisher(publisher, [name]).matched;
  assert.equal(same('JP Motion Pictures Pvt. Ltd.', 'JP Motion Pictures Private Limited'), true);
  assert.equal(same('SONY MUSIC ENTERTAINMENT INDIA PVT. LTD.', 'Sony Music India'), true);
  assert.equal(same('T-Series', 'T Series Music Pvt Ltd'), true);
});

test('the trader name is tried too, and trusted names win over claimed ones', () => {
  const bothOnFile = matchPublisher('Soul Music Bhojpuri', ['JP Motion Pictures Private Limited', 'Soul Music Bhojpuri']);
  assert.equal(bothOnFile.matched, true);
  assert.equal(bothOnFile.trust, MATCH_TRUST.TRUSTED);
  assert.equal(bothOnFile.matchedName, 'Soul Music Bhojpuri');

  const claimedOnly = matchPublisher('Zee Music Company', ['JP Motion Pictures Private Limited'], ['Zee Music']);
  assert.equal(claimedOnly.matched, true);
  assert.equal(claimedOnly.trust, MATCH_TRUST.CLAIMED);
});

test('a different company, or only generic words in common, does not match', () => {
  assert.equal(matchPublisher('Zee Music Company', ['JP Motion Pictures Private Limited']).matched, false);
  // "Music Pvt Ltd" is all generic words - it says nothing, so it matches nothing.
  assert.equal(matchPublisher('Music Pvt Ltd', ['JP Motion Pictures Music Pvt Ltd']).matched, false);
  assert.equal(matchPublisher('Sony Music', ['Sonic Pictures']).matched, false);
  assert.equal(matchPublisher('', ['JP Motion Pictures']).matched, false);
  assert.equal(matchPublisher(null, ['JP Motion Pictures']).matched, false);
});

test('several publishers on a song: any one of them may be the company', () => {
  assert.equal(matchPublisher(['Sony Music', 'JP Motion Pictures Pvt Ltd'], ['JP Motion Pictures']).matched, true);
});

// --- the questions' translations (pure) -----------------------------------

test('the publisher questions are translated into every language and keep the publisher as written', async () => {
  const sentences = [describePublisherAsk(), describePublisherMismatch('Zee Music Company'), describePublisherRetry('Zee Music Company')];
  for (const language of ['hi', 'mr', 'gu', 'bn', 'ur', 'ta', 'kn', 'te', 'or']) {
    for (const english of sentences) {
      const [translated] = await dictionaryTranslate([english], language);
      assert.notEqual(translated, english, `${language}: not translated: ${english.slice(0, 50)}`);
      if (english.includes('Zee Music Company')) assert.ok(translated.includes('"Zee Music Company"'), `${language}: publisher kept`);
    }
  }
});

// --- the flow through handle() ---------------------------------------------

let dbAvailable = false;
const createdAccountIds = [];
const WORK_URL_INPUT = { id: 'work-url-block', type: 'url input', options: { variableId: WORK_URL_VARIABLE_ID } };

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  for (const id of createdAccountIds) {
    await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccountsWorkRegistration.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function makeMember(data) {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9300${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
      ...data,
    },
  });
  createdAccountIds.push(account.AccountId);
  return String(account.AccountId);
}

// A company: official name in AccountName, the flow's traderName answer in AccountAlias.
const makeCompany = () =>
  makeMember({
    AccountRegType: 'C',
    RollTypeIds: '4',
    AccountName: 'JP Motion Pictures Private Limited',
    AccountAlias: 'Soul Music Bhojpuri',
  });

const song = (overrides = {}) => ({
  provider: 'spotify',
  url: `https://open.spotify.com/track/${Math.random().toString(36).slice(2)}`,
  songName: 'Test Song',
  artists: ['Someone Else'],
  credits: ['Someone Else'],
  composers: [],
  lyricists: [],
  publisher: 'JP Motion Pictures Pvt. Ltd.',
  ...overrides,
});

const YES = "Yes, that's my song";
const say = (userId, message) => handle({ userId, token: 'test-token', message });
const text = (res) => (res.messages ?? []).map((m) => m.content?.richText?.[0]?.children?.[0]?.text ?? '').join(' || ');

// The member has just been shown the song card and is about to answer "is this your song?".
function confirming(userId, resolved) {
  typebotSessionStore.set(userId, { sessionId: 'fake-session', input: WORK_URL_INPUT, pendingWorkLinkConfirm: { resolved } });
}

test('a song whose publisher is the company is saved straight away - no writer credit needed', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeCompany();
  confirming(userId, song());

  const res = await say(userId, YES);

  assert.notEqual(res.input?.id, 'work-link-alias', 'no trader-name question');
  const rows = await workLinkService.getWorkLinks(userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Publisher, 'JP Motion Pictures Pvt. Ltd.');
});

test('the trader name on file matches too', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeCompany();
  confirming(userId, song({ publisher: 'Soul Music Bhojpuri' }));

  const res = await say(userId, YES);

  assert.notEqual(res.input?.id, 'work-link-alias');
  assert.equal((await workLinkService.getWorkLinks(userId)).length, 1);
});

test('a song that names no publisher asks for it, and the answer is what the company is matched against and saved', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeCompany();
  confirming(userId, song({ publisher: null, provider: 'youtube', url: 'https://youtu.be/abc123' }));

  const asked = await say(userId, YES);
  assert.equal(asked.input?.id, 'work-link-publisher');
  assert.match(text(asked), /publisher or label/i);
  assert.equal((await workLinkService.getWorkLinks(userId)).length, 0, 'nothing is saved before the answer');

  await say(userId, 'JP Motion Pictures');
  const rows = await workLinkService.getWorkLinks(userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Publisher, 'JP Motion Pictures', 'saved on the row, so the per-song Publisher question is skipped');
});

test('a publisher that is not the company asks for a trader name; a name that matches saves the song and is remembered', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeCompany();
  confirming(userId, song({ publisher: 'Zee Music Company' }));

  const asked = await say(userId, YES);
  assert.equal(asked.input?.id, 'work-link-alias');
  assert.match(text(asked), /"Zee Music Company"/);
  assert.match(text(asked), /trader name/i);

  await say(userId, 'Zee Music');
  assert.equal((await workLinkService.getWorkLinks(userId)).length, 1);
  const account = await prisma.appAccounts.findUnique({ where: { AccountId: BigInt(userId) }, select: { AccountAlias: true } });
  assert.match(account.AccountAlias, /Zee Music/, 'remembered for the next song');
  assert.ok(account.AccountAlias.startsWith('Soul Music Bhojpuri'), 'the trusted trader name keeps position 0');
});

test('the trader-name step is bounded - after the last miss the song is saved for the team to verify', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeCompany();
  confirming(userId, song({ publisher: 'Zee Music Company' }));
  await say(userId, YES);

  let res;
  for (let attempt = 1; attempt < MAX_ALIAS_ATTEMPTS; attempt += 1) {
    res = await say(userId, 'Totally Different Name');
    assert.equal(res.input?.id, 'work-link-alias', 'asked again');
    assert.match(text(res), /"Zee Music Company"/, 'the retry names the publisher');
  }
  res = await say(userId, 'Another Wrong Name');

  assert.equal((await workLinkService.getWorkLinks(userId)).length, 1, 'never stuck: the song is saved');
  // The follow-up questions come next; the "team will verify" note is held to be shown after them.
  assert.equal(res.input?.id, 'work-film-album');
  assert.match(typebotSessionStore.get(userId).pendingWorkRowDetails.saved, /team will verify/i);
});

test('an author/composer member is still checked against the credits, not a publisher', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeMember({ AccountRegType: 'I', RollTypeIds: '1', AccountName: 'Rahul Kumar Sharma' });
  confirming(userId, song({ publisher: 'Rahul Kumar Sharma Records', composers: ['Pritam'], credits: ['Pritam'] }));

  const res = await say(userId, YES);

  assert.equal(res.input?.id, 'work-link-alias');
  assert.match(text(res), /not listed in this song's credits/i);
  assert.equal((await workLinkService.getWorkLinks(userId)).length, 0);
});
