// ==================================================================
// Work links - the cap, CreatedBy/ModifedBy, and the "grounded data only"
// rule (node:test).
//
// The gate's own vocabulary is pure and always runs; persistence needs
// SQL Server and is skipped when it isn't reachable.
//
// THE RULE THIS FILE DEFENDS: IPRS is a rights society, so a credit is
// written only when a source actually LABELLED it, never inferred. An
// empty column beats an invented credit.
//
// Author_Composer and Author_Lyricist are filled directly from the
// credits service's role-labelled output (Spotify's own contributor
// roles, or the credit block in a YouTube description) for the CONFIRMED
// song - saveWorkLink() only ever runs after the member has said "Yes,
// this is my song". The columns record the song's own writer credit,
// independent of which specific role the confirming member holds in it.
// The old Spotify artist bag and YouTube title never fill them either,
// because neither says who wrote the song. LanguageNames, WorkCategory,
// Film_AlbumName, Publisher and ReleaseYear are asked from the member
// directly when the link didn't supply them (see workDetailsGate.js);
// DocLink stays null always - nothing we can call sources it truthfully.
// Run: npm test
// ==================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { workLinkService, MAX_WORK_LINKS } from '../src/modules/work/services/workLink.service.js';
import {
  confirmsSong,
  wantsAnotherLink,
  isMoveOnKeyword,
  describeSong,
  describeCredits,
  isWorkLinkStep,
  WORK_URL_VARIABLE_ID,
  MAX_ALIAS_ATTEMPTS,
} from '../src/modules/conversation/services/typebot/workLinkGate.js';
import { typebotSessionStore } from '../src/modules/conversation/services/typebot/typebotSessionStore.js';
import { typebotClient } from '../src/modules/conversation/services/typebot/typebotClient.js';
import { handle } from '../src/modules/conversation/engines/registrationEngine.js';

// --- the gate's vocabulary (pure) ------------------------------------------

test('the work-link step recognises its own block', () => {
  assert.equal(isWorkLinkStep(WORK_URL_VARIABLE_ID), true);
  assert.equal(isWorkLinkStep('another-variable'), false);
});

test('confirmation answers', () => {
  for (const yes of ["Yes, that's my song", 'yes', 'Y', ' y ']) assert.equal(confirmsSong(yes), true, yes);
  for (const no of ['No, wrong link', 'no', 'maybe', '']) assert.equal(confirmsSong(no), false, no);
});

test('add-another answers', () => {
  for (const yes of ['Yes, add another', 'yes', 'add another']) assert.equal(wantsAnotherLink(yes), true, yes);
  for (const no of ['No, continue', 'no', '']) assert.equal(wantsAnotherLink(no), false, no);
});

test('move-on answers (the duplicate-link message\'s button)', () => {
  for (const yes of ['No, move on', 'no', 'move on', 'skip']) assert.equal(isMoveOnKeyword(yes), true, yes);
  // A real link (or anything else) must NOT be read as "move on" - it has to fall through and be
  // resolved as a fresh link paste, not silently discarded.
  for (const notMoveOn of ['https://open.spotify.com/track/abc', 'yes', '']) {
    assert.equal(isMoveOnKeyword(notMoveOn), false, notMoveOn);
  }
});

test('the song card shows only fields the provider actually returned', () => {
  const full = describeSong({
    songName: 'Kesariya', artists: ['Pritam', 'Arijit Singh'], filmOrAlbum: 'Brahmastra', releaseYear: 2022,
  });
  assert.match(full, /Song: Kesariya/);
  assert.match(full, /Artist: Pritam, Arijit Singh/);
  assert.match(full, /Film\/Album: Brahmastra/);
  assert.match(full, /Released: 2022/);
  assert.match(full, /Is this your song\?/);

  // A YouTube link has no release year and often no album - those lines must be absent, not blank.
  const sparse = describeSong({ songName: 'Some Song', artists: ['Someone'], filmOrAlbum: null, releaseYear: null });
  assert.equal(/Film\/Album/.test(sparse), false);
  assert.equal(/Released/.test(sparse), false);
});

test('the song card shows role-labelled credits when the service supplied them', () => {
  const withRoles = describeSong({
    songName: 'Apna Bana Le',
    artists: ['Arijit Singh'],
    filmOrAlbum: 'Bhediya',
    composers: ['Sachin-Jigar'],
    lyricists: ['Amitabh Bhattacharya'],
  });
  assert.match(withRoles, /Composer: Sachin-Jigar/);
  assert.match(withRoles, /Lyricist: Amitabh Bhattacharya/);

  // Absent when the credits service had nothing - no blank "Composer:" line.
  const withoutRoles = describeSong({ songName: 'Song', artists: ['Someone'], composers: [], lyricists: [] });
  assert.equal(/Composer/.test(withoutRoles), false);
  assert.equal(/Lyricist/.test(withoutRoles), false);
});

test('the credits prompt invites several names at once', () => {
  const message = describeCredits({ artists: ['Pritam', 'Arijit Singh'] });
  assert.match(message, /Pritam, Arijit Singh/);
  assert.match(message, /separate multiple names with commas/i);

  // Every credited name is listed, not just the performers - a member credited only as the
  // lyricist has to be able to see themselves in that list.
  assert.match(
    describeCredits({ artists: ['Arijit Singh'], credits: ['Arijit Singh', 'Amitabh Bhattacharya'] }),
    /Amitabh Bhattacharya/,
  );

  // Falls back to the channel name when the title could not be parsed into artists.
  assert.match(describeCredits({ artists: [], channelName: 'T-Series' }), /T-Series/);
  // And says something sensible with neither.
  assert.match(describeCredits({ artists: [] }), /not listed in this song's credits/i);
});

test('the alias loop is bounded - nobody may get stuck on this step', () => {
  assert.ok(Number.isInteger(MAX_ALIAS_ATTEMPTS) && MAX_ALIAS_ATTEMPTS > 0 && MAX_ALIAS_ATTEMPTS <= 5);
});

// --- persistence -----------------------------------------------------------

let dbAvailable = false;
const createdAccountIds = [];

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
    await prisma.appAccountsWorkRegistration.deleteMany({ where: { AccountId: id } }).catch(() => {});
    await prisma.appAccounts.delete({ where: { AccountId: id } }).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

async function makeAccount() {
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9200${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 10)}`,
    },
  });
  createdAccountIds.push(account.AccountId);
  return String(account.AccountId);
}

const spotifyTrack = (n = 1) => ({
  provider: 'spotify',
  url: `https://open.spotify.com/track/track${n}`,
  songName: `Song ${n}`,
  artists: ['Pritam', 'Arijit Singh'],
  filmOrAlbum: 'Brahmastra',
  releaseYear: 2022,
  publisher: 'Sony Music Entertainment India Pvt. Ltd.',
  credits: ['Pritam', 'Arijit Singh'],
});

test('a link with no role-labelled credits leaves the writer columns null', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  // spotifyTrack() carries artists but no composers/lyricists - the shape the resolver returns
  // when the credits service is off or had nothing. An artist list is not a writer credit.
  const row = await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(), accountName: 'Test Member' });

  assert.equal(row.SongName, 'Song 1');
  assert.equal(row.Film_AlbumName, 'Brahmastra');
  assert.equal(row.Artist_Singers, 'Pritam, Arijit Singh');
  assert.equal(Number(row.ReleaseYear), 2022);

  assert.equal(row.Author_Composer, null, 'an artist bag must never become a composer credit');
  assert.equal(row.Author_Lyricist, null, 'an artist bag must never become a lyricist credit');

  // Still nothing we can source truthfully - these remain for staff.
  assert.equal(row.LanguageNames, null);
  assert.equal(row.WorkCategory, null);
  assert.equal(row.DocLink, null);
});

test('role-labelled credits are written to both writer columns from the song\'s own credits', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const row = await workLinkService.saveWorkLink({
    userId,
    resolved: {
      ...spotifyTrack(),
      composers: ['Sachin-Jigar'],
      // Duplicates collapse, and several writers share the one column.
      lyricists: ['Amitabh Bhattacharya', 'Amitabh Bhattacharya', 'Priya Saraiya'],
    },
    accountName: 'Test Member',
  });

  assert.equal(row.Author_Composer, 'Sachin-Jigar');
  assert.equal(row.Author_Lyricist, 'Amitabh Bhattacharya, Priya Saraiya');

  // Never sourced, so never written - the rule that survives this change.
  assert.equal(row.LanguageNames, null);
  assert.equal(row.WorkCategory, null);
  assert.equal(row.DocLink, null);
});

test('the writer columns are written even when the confirming member holds a different role on the song', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  // The member confirmed the song as, say, a credited performer, not the composer/lyricist -
  // Author_Composer/Author_Lyricist record the SONG's own writer credit regardless, since
  // saveWorkLink() only ever runs after the member has already confirmed this is their song.
  const row = await workLinkService.saveWorkLink({
    userId,
    resolved: {
      ...spotifyTrack(),
      composers: ['Sachin-Jigar'],
      lyricists: ['Amitabh Bhattacharya'],
    },
    accountName: 'Test Member',
  });

  assert.equal(row.Author_Composer, 'Sachin-Jigar');
  assert.equal(row.Author_Lyricist, 'Amitabh Bhattacharya');
});

test('an empty credit list is stored as null, not an empty string', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const row = await workLinkService.saveWorkLink({
    userId,
    resolved: { ...spotifyTrack(), composers: [], lyricists: ['  '] },
    accountName: 'Test Member',
  });

  assert.equal(row.Author_Composer, null);
  assert.equal(row.Author_Lyricist, null);
});

test('a crowded writer credit is clipped to the column width', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const row = await workLinkService.saveWorkLink({
    userId,
    resolved: {
      ...spotifyTrack(),
      composers: Array.from({ length: 40 }, (_, i) => `Composer Number ${i}`),
      lyricists: Array.from({ length: 40 }, (_, i) => `Lyricist Number ${i}`),
    },
    accountName: 'Test Member',
  });

  assert.ok(row.Author_Composer.length <= 100, `Author_Composer ${row.Author_Composer.length}`);
  assert.ok(row.Author_Lyricist.length <= 100, `Author_Lyricist ${row.Author_Lyricist.length}`);
});

test('CreatedBy and ModifedBy both record the member\'s own account name', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const row = await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(1), accountName: 'Jane Songwriter' });

  assert.equal(row.CreatedBy, 'Jane Songwriter');
  assert.equal(row.ModifedBy, 'Jane Songwriter');
});

test(`the cap holds at ${MAX_WORK_LINKS} - the next link is refused, not silently dropped`, async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  for (let i = 1; i <= MAX_WORK_LINKS; i += 1) {
    const row = await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(i), accountName: 'Test Member' });
    assert.ok(row, `link ${i} should have saved`);
  }
  assert.equal(await workLinkService.countWorkLinks(userId), MAX_WORK_LINKS);

  // null is the signal the engine turns into a visible notice for the member.
  const overflow = await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(99), accountName: 'Test Member' });
  assert.equal(overflow, null);
  assert.equal(await workLinkService.countWorkLinks(userId), MAX_WORK_LINKS, 'nothing extra was written');
});

// --- duplicate-link check ----------------------------------------------------

test('the same link cannot be added twice for one member - the second attempt is refused', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const first = await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(1), accountName: 'Test Member' });
  assert.ok(first, 'the first save succeeds');

  await assert.rejects(
    () => workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(1), accountName: 'Test Member' }),
    (err) => {
      assert.equal(err.errorCode, 'WORK_LINK_DUPLICATE');
      assert.equal(err.statusCode, 409);
      return true;
    },
  );

  assert.equal(await workLinkService.countWorkLinks(userId), 1, 'the rejected duplicate did not count against the cap');
});

test('the same link IS allowed for two different members - the check is per-account', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userA = await makeAccount();
  const userB = await makeAccount();

  const rowA = await workLinkService.saveWorkLink({ userId: userA, resolved: spotifyTrack(1), accountName: 'Test Member' });
  const rowB = await workLinkService.saveWorkLink({ userId: userB, resolved: spotifyTrack(1), accountName: 'Test Member' });

  assert.ok(rowA);
  assert.ok(rowB);
});

test('over-long values are clipped to the column width instead of failing the insert', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  const row = await workLinkService.saveWorkLink({
    userId,
    resolved: {
      ...spotifyTrack(),
      songName: 'S'.repeat(300),
      filmOrAlbum: 'F'.repeat(300),
      artists: Array.from({ length: 80 }, (_, i) => `Artist Number ${i}`),
      publisher: 'P'.repeat(300),
      url: `https://open.spotify.com/track/x?${'q'.repeat(800)}`,
    },
    accountName: 'Test Member',
  });

  assert.ok(row.SongName.length <= 100, `SongName ${row.SongName.length}`);
  assert.ok(row.Film_AlbumName.length <= 100, `Film_AlbumName ${row.Film_AlbumName.length}`);
  assert.ok(row.Artist_Singers.length <= 500, `Artist_Singers ${row.Artist_Singers.length}`);
  assert.ok(row.Publisher.length <= 100, `Publisher ${row.Publisher.length}`);
  assert.ok(row.DigitalLink.length <= 500, `DigitalLink ${row.DigitalLink.length}`);
});

test('missing optional metadata is stored as null, not an empty string', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  // A YouTube link: no release year, no publisher, often no album.
  const row = await workLinkService.saveWorkLink({
    userId,
    resolved: {
      provider: 'youtube',
      url: 'https://www.youtube.com/watch?v=abc123',
      songName: 'Some Song',
      artists: ['A Channel'],
      filmOrAlbum: null,
      releaseYear: null,
      publisher: null,
      credits: ['A Channel'],
    },
    accountName: 'Test Member',
  });

  assert.equal(row.Film_AlbumName, null);
  assert.equal(row.ReleaseYear, null);
  assert.equal(row.Publisher, null);
  assert.equal(row.DigitalLink, 'https://www.youtube.com/watch?v=abc123');
});

// --- clearing on "Start over" -----------------------------------------------

test('clearWorkLinks removes every song for that member', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(1), accountName: 'Test Member' });
  await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(2), accountName: 'Test Member' });
  assert.equal(await workLinkService.countWorkLinks(userId), 2);

  await workLinkService.clearWorkLinks(userId);

  assert.equal(await workLinkService.countWorkLinks(userId), 0);
  // Not just uncounted - actually gone, so a fresh link after this starts a clean cap.
  const row = await workLinkService.saveWorkLink({ userId, resolved: spotifyTrack(3), accountName: 'Test Member' });
  assert.ok(row, 'the cap was not left exhausted by the cleared rows');
  assert.equal(await workLinkService.countWorkLinks(userId), 1, 'only the new link counts');
});

test('clearWorkLinks never touches another member', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userA = await makeAccount();
  const userB = await makeAccount();

  await workLinkService.saveWorkLink({ userId: userA, resolved: spotifyTrack(1), accountName: 'Test Member' });
  await workLinkService.saveWorkLink({ userId: userB, resolved: spotifyTrack(2), accountName: 'Test Member' });

  await workLinkService.clearWorkLinks(userA);

  assert.equal(await workLinkService.countWorkLinks(userA), 0);
  assert.equal(await workLinkService.countWorkLinks(userB), 1, "someone else's restart must not touch this");
});

// --- the "No, move on" button on the duplicate-link message -----------------
// End-to-end through handle(), driven from a pendingWorkLinkDuplicate session state directly
// (rather than re-simulating the whole song-confirm/alias flow that produces it) - this isolates
// exactly the new code path: does the button bypass/replay, and does anything else still fall
// through as a fresh link-paste attempt instead of getting silently swallowed?

const WORK_URL_INPUT = { id: 'work-url-block', type: 'url input', options: { variableId: WORK_URL_VARIABLE_ID } };

test('tapping "No, move on" bypasses and replays the duplicate link to Typebot - session advances', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();
  const duplicateUrl = 'https://open.spotify.com/track/already-added';

  typebotSessionStore.set(userId, {
    sessionId: 'fake-session',
    input: WORK_URL_INPUT,
    pendingWorkLinkDuplicate: { url: duplicateUrl },
  });

  let continueChatMessage;
  const originalContinueChat = typebotClient.continueChat;
  typebotClient.continueChat = async ({ message }) => {
    continueChatMessage = message;
    return { sessionId: 'fake-session', messages: [], input: { id: 'next-block', type: 'text input' } };
  };

  try {
    const res = await handle({ userId, token: 'test-token', message: 'No, move on' });
    assert.equal(continueChatMessage?.text, duplicateUrl, 'the duplicate link was replayed to advance Typebot');
    assert.equal(res.input?.id, 'next-block', 'the conversation advanced past the work-link step');
  } finally {
    typebotClient.continueChat = originalContinueChat;
  }
});

test('ignoring the button and sending anything else falls through - the flow is not blocked', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const userId = await makeAccount();

  typebotSessionStore.set(userId, {
    sessionId: 'fake-session',
    input: WORK_URL_INPUT,
    pendingWorkLinkDuplicate: { url: 'https://open.spotify.com/track/already-added' },
  });

  const originalContinueChat = typebotClient.continueChat;
  typebotClient.continueChat = async () => {
    throw new Error('continueChat should not be called - an unresolved link must stay on this step, not advance');
  };

  try {
    // Not the move-on keyword, and not a real Spotify/YouTube link either - the same "please share
    // a link" retry an ordinary unrecognised paste gets, proving the duplicate state doesn't trap
    // the member on some other message instead.
    const res = await handle({ userId, token: 'test-token', message: 'not a link at all' });
    assert.equal(res.input?.id, 'work-url-block', 'still parked on the work-link question, not stuck elsewhere');
    const text = res.messages[0].content.richText[0].children[0].text ?? JSON.stringify(res.messages[0]);
    assert.match(text, /Spotify or YouTube/);
  } finally {
    typebotClient.continueChat = originalContinueChat;
  }
});
