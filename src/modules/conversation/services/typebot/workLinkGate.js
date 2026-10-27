// ==================================================================
// Gates the Typebot conversation's "share a link to your work" step.
//
// The published flow asks for one link and moves on. Everything else the
// step now does - identifying the provider, showing the song back for
// confirmation, asking for a credited name when the match fails, and
// looping up to MAX_WORK_LINKS - is driven from the backend, using
// synthetic blocks: objects shaped like Typebot inputs that Typebot has
// never heard of, which the frontend renders like any other question.
// Same pattern as registrationEngine.js's OCR-confirmation and email-OTP
// steps. Studio needs no changes.
//
// All four role paths share one `workUrl` variable - see AGENTS.md.
// ==================================================================
import { MAX_WORK_LINKS } from '../../../work/services/workLink.service.js';

export const WORK_URL_VARIABLE_ID = 'vdcqjfwmljgel9ola6lpinafa'; // workUrl

// Re-exported so the engine imports its conversational constants from one
// place; the cap itself is owned and enforced by workLink.service.js.
export { MAX_WORK_LINKS };

// How many times a member may offer a credited name before we stop asking and save the link for
// staff to verify. Bounded so nobody can get stuck on this step - see AGENTS.md.
export const MAX_ALIAS_ATTEMPTS = 2;

export function isWorkLinkStep(variableId) {
  return variableId === WORK_URL_VARIABLE_ID;
}

// --- Synthetic blocks -------------------------------------------------------

export const WORK_LINK_CONFIRM_INPUT = {
  id: 'work-link-confirm',
  type: 'choice input',
  items: [
    { id: 'work-link-confirm-yes', content: "Yes, that's my song" },
    { id: 'work-link-confirm-no', content: 'No, wrong link' },
  ],
};

export const WORK_LINK_ALIAS_INPUT = {
  id: 'work-link-alias',
  type: 'text input',
  options: { labels: { placeholder: 'e.g. Aditya Prateek, AP' } },
};

// Asked of an Owner/Publisher member when the song's own data names no publisher (every YouTube link,
// and some Spotify ones) - the company is matched against what they answer.
export const WORK_LINK_PUBLISHER_INPUT = {
  id: 'work-link-publisher',
  type: 'text input',
  options: { labels: { placeholder: 'e.g. T-Series' } },
};

export const WORK_LINK_MORE_INPUT = {
  id: 'work-link-add-another',
  type: 'choice input',
  items: [
    { id: 'work-link-yes', content: 'Yes, add another' },
    { id: 'work-link-no', content: 'No, continue' },
  ],
};

// --- Answer readers ---------------------------------------------------------

function normalizeAnswer(message) {
  return String(message ?? '').trim().toLowerCase();
}

export function confirmsSong(message) {
  const answer = normalizeAnswer(message);
  return ["yes, that's my song", 'yes', 'y'].includes(answer);
}

export function wantsAnotherLink(message) {
  const answer = normalizeAnswer(message);
  return ['yes, add another', 'yes', 'y', 'add another'].includes(answer);
}

// Recognizes the "No, move on" button on the duplicate-link message (registrationEngine.js's
// WORK_LINK_DUPLICATE branch) - a real url-input block with a button attached, not a synthetic
// choice input, so anything that ISN'T this keyword falls through as a fresh link paste attempt
// rather than being read as a decline (unlike wantsAnotherLink, which owns a strict yes/no step).
//
// "No, continue" is accepted too, and that is not optional: a tapped button comes back to the engine as
// its translated label, mapped to English through the dictionary. "No, move on" and the add-another
// step's "No, continue" read the same in every language, so the dictionary hands a tap on "No, move
// on" back as "No, continue" - which used to be taken for a pasted link and ask for the link again.
export function isMoveOnKeyword(message) {
  const answer = normalizeAnswer(message);
  return ['no, move on', 'no, continue', 'no', 'move on', 'continue', 'skip'].includes(answer);
}

// --- Message text -----------------------------------------------------------

// The card the member confirms against. Only fields the provider actually returned are shown -
// a "Film/Album: —" line for every Spotify single would be noise.
export function describeSong(resolved) {
  const lines = [`Song: ${resolved.songName ?? 'Unknown'}`];
  if (resolved.artists?.length) lines.push(`Artist: ${resolved.artists.join(', ')}`);
  if (resolved.filmOrAlbum) lines.push(`Film/Album: ${resolved.filmOrAlbum}`);
  if (resolved.releaseYear) lines.push(`Released: ${resolved.releaseYear}`);
  // Role-labelled credits, shown only when the credits service supplied them. These are the two
  // lines a songwriter is most likely to check, and the ones that end up in the register.
  if (resolved.composers?.length) lines.push(`Composer: ${resolved.composers.join(', ')}`);
  if (resolved.lyricists?.length) lines.push(`Lyricist: ${resolved.lyricists.join(', ')}`);
  // The label, so an Owner/Publisher member can see what their company is being matched against.
  const publisher = [resolved.publisher].flat().filter(Boolean);
  if (publisher.length) lines.push(`Publisher: ${publisher.join(', ')}`);
  return `${lines.join('\n')}\n\nIs this your song?`;
}

// Owner/Publisher members: the company is matched on the song's publisher, not on writer credits.
export function describePublisherAsk() {
  return 'Who is the publisher or label of this song?';
}

// The publisher is the member's own text or the platform's label - quoted, so the translator keeps it
// as typed and one sentence serves every song.
export function describePublisherMismatch(publisher) {
  return `This song's publisher is "${publisher}", which doesn't match your company name or trader name.\n\nPlease enter the trader name this publisher is credited under. (Enter separate multiple names with commas)`;
}

export function describePublisherRetry(publisher) {
  return `That name doesn't match the publisher "${publisher}" either. Please check how the publisher appears on the release and enter your trader name exactly.`;
}

// What a resumed chat shows under a link the member pasted earlier: the song as saved, including the
// answers to the follow-up questions (workDetailsGate.js) that never reach the conversation journal.
// Only fields on file are listed; null when nothing but the link is known.
export function describeSavedSong(row) {
  const fields = [
    ['Song', row?.SongName],
    ['Film/Album', row?.Film_AlbumName],
    ['Publisher', row?.Publisher],
    ['Category', row?.WorkCategory],
    ['Language', row?.LanguageNames],
    ['Released', row?.ReleaseYear],
  ];
  const lines = fields.filter(([, value]) => value != null && String(value).trim()).map(([label, value]) => `${label}: ${value}`);
  return lines.length ? `Song details saved\n\n${lines.join('\n')}` : null;
}

// Members are invited to give more than one name: a legal name, a stage name and an abbreviation
// are all common, and every name they give is stored so their next links match without asking again.
export function describeCredits(resolved) {
  // Every credited name the platform reported, so a member credited only as the lyricist sees
  // themselves in the list. Falls back to the performers, then the channel.
  const listed = resolved.credits?.length ? resolved.credits : resolved.artists;
  const credits = listed?.length ? listed.join(', ') : resolved.channelName;
  const ask = 'What name are you credited under? (Enter separate multiple names with commas)';
  return credits
    ? `You're not listed in this song's credits: ${credits}.\n\n${ask}`
    : `You're not listed in this song's credits.\n\n${ask}`;
}
