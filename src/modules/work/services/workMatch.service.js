// ==================================================================
// Does this song's credits include the member - and how much is that
// worth?
//
// HOW NAMES ARE COMPARED
//
// Indian names make a plain string comparison useless in both
// directions. A PAN card says "RAHUL KUMAR SHARMA" while the release
// credits "Rahul Sharma"; "Allah Rakha Rahman" is credited "A.R.
// Rahman". Requiring the strings to be equal rejects the member's own
// songs. But loosening it to "is this name somewhere in that string"
// lets a bare "Singh" match half the catalogue.
//
// So names are compared as tokens, and the rule is: the FIRST and LAST
// tokens must correspond; everything in between is ignored.
//
//   first/last correspond when they are equal, when one is the other's
//   initial ("a" ~ "allah"), or when they differ by a single typo
//   (tokens of 4+ characters only - at 3 characters an edit is a
//   different name, not a slip).
//
// That accepts a dropped middle name, an initial, and a one-letter
// typo, while still requiring both ends of the name to line up - so
// "Arijit Kumar" does not match "Arijit Singh".
//
// A single-token name is handled asymmetrically, on purpose. A credit
// of one token is a stage mononym ("Pritam", "Badshah") and may match
// the member's first or last token. But a single token supplied by the
// *member* must equal the whole credit or its first token - otherwise
// typing "Singh" would match "Arijit Singh". The credits come from the
// platform; what the member types has to be more specific than that.
//
// A YouTube video title is a sentence, not a name, so it is matched
// separately (`creditText`) with a word-boundary containment test, and
// only for names of two or more tokens - the same "Singh" guard.
//
// WHAT A MATCH IS WORTH
//
//   trusted - AccountName (from an identity document) or AccountAlias
//             (the stage name asked during registration). Both were on
//             file *before* the member saw this song's credits.
//   claimed - a name the member gave at the work-link step, i.e. after
//             we showed them the credit list. Copying a name off that
//             list is trivial, so a match here is the member's claim,
//             not a check, and the work link is stored unverified.
//
// A claimed alias stays claimed on later songs too - being in the alias
// table doesn't promote it. See AGENTS.md.
// ==================================================================
import { normalizeName } from '../../../utils/name.js';

export const MATCH_TRUST = Object.freeze({ TRUSTED: 'trusted', CLAIMED: 'claimed', NONE: 'none' });

// Below this length a single edit is a different name, not a typo ("ravi"/"ravu" is a slip,
// "raj"/"ram" is not).
const MIN_LENGTH_FOR_TYPO = 4;

function tokens(value) {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

// True when a and b differ by at most one insertion, deletion or substitution.
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edited = false;

  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (edited) return false;
    edited = true;
    if (shorter.length === longer.length) i += 1; // substitution
    j += 1; // insertion/deletion
  }

  return true;
}

// The first and last name tokens. "Compatible" is deliberately generous - see the header.
function tokensCorrespond(a, b) {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0]; // initial vs full token
  if (a.length >= MIN_LENGTH_FOR_TYPO && b.length >= MIN_LENGTH_FOR_TYPO) return withinOneEdit(a, b);
  return false;
}

// `candidate` is a name we hold for the member; `credit` is a name the platform reported.
function namesMatch(candidate, credit) {
  const mine = tokens(candidate);
  const theirs = tokens(credit);
  if (mine.length === 0 || theirs.length === 0) return false;

  // A mononym credit ("Pritam") may be the member's first or last token.
  if (theirs.length === 1) {
    if (mine.length === 1) return tokensCorrespond(mine[0], theirs[0]);
    return tokensCorrespond(mine[0], theirs[0]) || tokensCorrespond(mine[mine.length - 1], theirs[0]);
  }

  // A single token from the member must be the whole credit or its first token - never its
  // surname, or "Singh" would match everyone.
  if (mine.length === 1) return tokensCorrespond(mine[0], theirs[0]);

  return (
    tokensCorrespond(mine[0], theirs[0]) &&
    tokensCorrespond(mine[mine.length - 1], theirs[theirs.length - 1])
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Free text (a YouTube video title) - containment on word boundaries. Two-token minimum: a single
// common token would match almost any title. Boundaries matter too, or "Raj" hits "Rajesh".
function textContainsName(text, candidate) {
  const normalizedText = normalizeName(text);
  const name = tokens(candidate);
  if (!normalizedText || name.length < 2) return false;

  const phrase = name.join(' ');
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`, 'i').test(normalizedText);
}

function searchList(list, name) {
  return (Array.isArray(list) ? list.filter(Boolean) : []).find((entry) => namesMatch(name, entry)) ?? null;
}

function findMatch({ credits, creditText }, names) {
  const candidates = (Array.isArray(names) ? names : [names]).filter((n) => tokens(n).length > 0);

  for (const candidate of candidates) {
    const credit = searchList(credits, candidate);
    if (credit) return { matchedName: candidate, matchedCredit: credit };

    if (creditText && textContainsName(creditText, candidate)) {
      return { matchedName: candidate, matchedCredit: creditText };
    }
  }

  return null;
}

// Which role-labelled list on `resolved` a required role searches - workLinkResolver's
// roleFields() puts these there (empty arrays when the credits service had nothing).
function roleListFor(resolved, role) {
  if (role === 'Lyricist') return resolved?.lyricists;
  if (role === 'Composer') return resolved?.composers;
  return null;
}

// One name against one required role (Lyricist/Composer). If the song has role-labelled data for
// this role, the match must come from that specific list - a composer credit no longer counts for
// a Lyricist-only member, even though it's still in the merged `credits`. If the song has NO
// role-labelled data at all for this role (an older YouTube video with only a title, say), fall
// back to the ordinary role-blind credits/creditText search rather than blocking the member over
// missing platform data - confirmed with the user.
function findRoleMatch(resolved, role, name) {
  const list = roleListFor(resolved, role);
  if (Array.isArray(list) && list.length > 0) {
    const credit = searchList(list, name);
    return credit ? { matchedName: name, matchedCredit: credit } : null;
  }
  return findMatch(resolved, name);
}

// matchCredits(resolved, trustedNames, claimedNames, roles)
//   resolved: { credits: string[], creditText?: string, lyricists?: string[], composers?: string[] }
//   roles: the confirming member's own roles, e.g. ['Lyricist'], ['Composer'], or both for "Both"
//          (memberRoleCodes.js's listRoleLabels()) - omit/empty for the old role-blind check
//          (the Publisher paths have no Lyricist/Composer role at all).
// -> { matched, trust, matchedName, matchedCredit }
//
// Trusted names are tried first so a member who *is* on file is never downgraded just because they
// also happen to have an alias stored. Every name on file (trusted, then claimed) is tried against
// every required role - "Both" means the SAME name must satisfy both roles, not just appear once.
export function matchCredits(resolved, trustedNames, claimedNames = [], roles = []) {
  const source = Array.isArray(resolved) ? { credits: resolved } : (resolved ?? { credits: [] });
  const requiredRoles = Array.isArray(roles) ? roles.filter(Boolean) : [];

  function tryNames(names) {
    if (requiredRoles.length === 0) return findMatch(source, names);

    const candidates = (Array.isArray(names) ? names : [names]).filter((n) => tokens(n).length > 0);
    for (const candidate of candidates) {
      const perRole = requiredRoles.map((role) => findRoleMatch(source, role, candidate));
      if (perRole.every(Boolean)) return { matchedName: candidate, matchedCredit: perRole[0].matchedCredit };
    }
    return null;
  }

  const trusted = tryNames(trustedNames);
  if (trusted) return { matched: true, trust: MATCH_TRUST.TRUSTED, ...trusted };

  const claimed = tryNames(claimedNames);
  if (claimed) return { matched: true, trust: MATCH_TRUST.CLAIMED, ...claimed };

  return { matched: false, trust: MATCH_TRUST.NONE, matchedName: null, matchedCredit: null };
}

export const workMatchService = { matchCredits, MATCH_TRUST };
