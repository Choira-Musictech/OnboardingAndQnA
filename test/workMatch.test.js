// ==================================================================
// The name-matching rules behind work-link verification (node:test).
//
// Pure functions - no DB, no network, so these always run.
//
// These rules were the hardest part of the work-link feature to get
// right, and they are easy to break by "tightening" or "loosening" one
// comparison. Each test below names the real-world case it protects:
// Indian members drop middle names, sign with initials, and mistype
// their own transliteration - while a bare surname must never match
// half the catalogue.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCredits, MATCH_TRUST } from '../src/modules/work/services/workMatch.service.js';
import { normalizeName } from '../src/utils/name.js';

// matchCredits(resolved, trustedNames, claimedNames). Most cases here only care whether a name
// lines up with a credit at all, so trust is supplied as "trusted" unless the test says otherwise.
const matches = (credits, name) => matchCredits({ credits }, [name]).matched;
const matchesText = (creditText, name) => matchCredits({ credits: [], creditText }, [name]).matched;

// --- what must match -------------------------------------------------------

test('an exact credit matches', () => {
  assert.equal(matches(['Arijit Singh'], 'Arijit Singh'), true);
});

test('case and surrounding whitespace are ignored', () => {
  assert.equal(matches(['  ARIJIT   SINGH '], 'arijit singh'), true);
});

test('a dropped middle name still matches - PAN says the long form, the release does not', () => {
  assert.equal(matches(['Rahul Sharma'], 'Rahul Kumar Sharma'), true);
  assert.equal(matches(['Rahul Kumar Sharma'], 'Rahul Sharma'), true);
});

test('initials match the full token - "A.R. Rahman" is "Allah Rakha Rahman"', () => {
  assert.equal(matches(['A.R. Rahman'], 'Allah Rakha Rahman'), true);
  assert.equal(matches(['A R Rahman'], 'Allah Rakha Rahman'), true);
});

test('a one-letter typo is forgiven on tokens of 4+ characters', () => {
  assert.equal(matches(['Ravu Shankar'], 'Ravi Shankar'), true); // substitution
  assert.equal(matches(['Shreya Ghosal'], 'Shreya Ghoshal'), true); // deletion
});

test('a mononym credit may be the member\'s first or last token', () => {
  assert.equal(matches(['Pritam'], 'Pritam Chakraborty'), true);
  assert.equal(matches(['Chakraborty'], 'Pritam Chakraborty'), true);
});

test('a single token from the member matches the credit\'s FIRST token', () => {
  assert.equal(matches(['Arijit Singh'], 'Arijit'), true);
});

// --- what must NOT match ---------------------------------------------------

test('a bare surname does not match - otherwise "Singh" claims half the catalogue', () => {
  assert.equal(matches(['Arijit Singh'], 'Singh'), false);
  assert.equal(matches(['Neha Kakkar'], 'Kakkar'), false);
});

test('both ends of the name must line up - a shared first name is not enough', () => {
  assert.equal(matches(['Arijit Singh'], 'Arijit Kumar'), false);
});

test('a shared surname is not enough either', () => {
  assert.equal(matches(['Arijit Singh'], 'Sukhwinder Singh'), false);
});

test('short tokens get no typo tolerance - "Raj" and "Ram" are different names', () => {
  assert.equal(matches(['Ram Kumar'], 'Raj Kumar'), false);
});

test('an initial must be the right letter', () => {
  assert.equal(matches(['B.R. Rahman'], 'Allah Rakha Rahman'), false);
});

test('empty and missing values never match', () => {
  assert.equal(matches(['Arijit Singh'], ''), false);
  assert.equal(matches([''], 'Arijit Singh'), false);
  assert.equal(matchCredits({ credits: [] }, ['Arijit Singh']).matched, false);
  assert.equal(matchCredits({ credits: ['Arijit Singh'] }, undefined).matched, false);
});

// --- free text (a YouTube title, not a name list) --------------------------

test('a full name is found inside a video title', () => {
  assert.equal(matchesText('Kesariya - Brahmastra | Arijit Singh | Pritam', 'Arijit Singh'), true);
});

test('a single token is never searched in free text - a common word would match any title', () => {
  assert.equal(matchesText('Kesariya - Brahmastra | Arijit Singh | Pritam', 'Singh'), false);
  assert.equal(matchesText('Kesariya - Brahmastra | Arijit Singh | Pritam', 'Arijit'), false);
});

test('free-text search respects word boundaries', () => {
  assert.equal(matchesText('New song by Arijit Singhania', 'Arijit Singh'), false);
});

// --- what a match is worth -------------------------------------------------

test('a name on file beforehand is trusted', () => {
  const result = matchCredits({ credits: ['Pritam', 'Arijit Singh'] }, ['Arijit Singh'], []);
  assert.equal(result.trust, MATCH_TRUST.TRUSTED);
  assert.equal(result.matchedCredit, 'Arijit Singh');
});

test('a name given after the credits were shown is only a claim', () => {
  const result = matchCredits({ credits: ['Pritam'] }, [], ['Pritam Chakraborty']);
  assert.equal(result.matched, true);
  assert.equal(result.trust, MATCH_TRUST.CLAIMED);
});

test('trusted names win - an alias never downgrades a member who is genuinely on file', () => {
  const result = matchCredits(
    { credits: ['Pritam', 'Arijit Singh'] },
    ['Arijit Singh'],
    ['Pritam'],
  );
  assert.equal(result.trust, MATCH_TRUST.TRUSTED);
  assert.equal(result.matchedName, 'Arijit Singh');
});

test('no match reports NONE with nothing attached', () => {
  const result = matchCredits({ credits: ['Pritam'] }, ['Arijit Singh'], ['Neha Kakkar']);
  assert.deepEqual(result, {
    matched: false,
    trust: MATCH_TRUST.NONE,
    matchedName: null,
    matchedCredit: null,
  });
});

test('a bare array of credits is accepted as the first argument', () => {
  assert.equal(matchCredits(['Arijit Singh'], ['Arijit Singh']).matched, true);
});

// --- role-specific matching (Lyricist / Composer / Both) --------------------

test('a Lyricist-only member matches only against the song\'s lyricist credits', () => {
  const resolved = { credits: ['Name A', 'Name B'], lyricists: ['Name A'], composers: ['Name B'] };

  assert.equal(matchCredits(resolved, ['Name A'], [], ['Lyricist']).matched, true);
  // Credited as the composer, not the lyricist - still in the merged `credits`, but that must
  // no longer be enough for a Lyricist-only member.
  assert.equal(matchCredits(resolved, ['Name B'], [], ['Lyricist']).matched, false);
});

test('a Composer-only member matches only against the song\'s composer credits', () => {
  const resolved = { credits: ['Name A', 'Name B'], lyricists: ['Name A'], composers: ['Name B'] };

  assert.equal(matchCredits(resolved, ['Name B'], [], ['Composer']).matched, true);
  assert.equal(matchCredits(resolved, ['Name A'], [], ['Composer']).matched, false);
});

test('a "Both" member must be in the lyricist AND the composer credits, not just one', () => {
  const resolved = {
    credits: ['Name A', 'Name B', 'Name C'],
    lyricists: ['Name A', 'Name C'],
    composers: ['Name B', 'Name C'],
  };

  assert.equal(matchCredits(resolved, ['Name C'], [], ['Lyricist', 'Composer']).matched, true);
  // Only a lyricist on this song, not also the composer.
  assert.equal(matchCredits(resolved, ['Name A'], [], ['Lyricist', 'Composer']).matched, false);
  // Only a composer on this song, not also the lyricist.
  assert.equal(matchCredits(resolved, ['Name B'], [], ['Lyricist', 'Composer']).matched, false);
});

test('with no role-labelled list at all for the role, the role-blind credits/creditText still work', () => {
  // An older YouTube video with nothing structured - lyricists/composers are empty arrays, same as
  // workLinkResolver's roleFields() default - so the member isn't blocked over missing platform
  // data; the fallback is the ordinary merged-credits/free-text check.
  const resolved = { credits: ['Name A'], lyricists: [], composers: [] };
  assert.equal(matchCredits(resolved, ['Name A'], [], ['Lyricist']).matched, true);

  const textOnly = { credits: [], creditText: 'Some Song | Name A | Name B', lyricists: [], composers: [] };
  assert.equal(matchCredits(textOnly, ['Name A'], [], ['Composer']).matched, true);
});

test('role-specific matching is opt-in - calls with no roles argument keep today\'s role-blind behavior', () => {
  const resolved = { credits: ['Name B'], lyricists: ['Name A'], composers: ['Name B'] };
  // Name B is only a composer, but with no roles passed (e.g. the Publisher paths, which have no
  // Lyricist/Composer role at all) the merged `credits` list is still what's checked.
  assert.equal(matchCredits(resolved, ['Name B'], []).matched, true);
  assert.equal(matchCredits(resolved, ['Name B'], [], []).matched, true);
});

// --- normalisation ---------------------------------------------------------

test('a full stop becomes a space, not nothing', () => {
  // Deleting it collapsed "A.R." into the single token "ar", which then never lined up with
  // "Allah Rakha". This is the regression that broke initial-matching once.
  assert.equal(normalizeName('A.R. Rahman'), 'a r rahman');
});

test('curly quotes, unicode dashes and commas are folded', () => {
  assert.equal(normalizeName('D’Souza'), "d'souza");
  assert.equal(normalizeName('Singh, Arijit'), 'singh arijit');
});
