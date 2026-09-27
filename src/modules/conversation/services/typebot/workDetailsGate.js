// ==================================================================
// Gates the follow-up asked right after each song is confirmed and saved
// (see saveAndOfferAnother() in registrationEngine.js), before offering
// another link slot or handing the conversation back to Typebot.
//
// Film_AlbumName, Publisher, LanguageNames and WorkCategory can't always
// be sourced from Spotify or YouTube - see musicCredits.service.js - and
// ReleaseYear is frequently missing too (the Spotify Web API's known 403
// issue leaves it null on most Spotify links). All five are per-row
// columns on App_Accounts_WorkRegistration, so each song the member added
// is asked separately, one field at a time, same synthetic-block pattern
// as workLinkGate.js. A field already on file (e.g. a resumed session, or
// a YouTube link whose description did carry a year) is never re-asked.
// ==================================================================
import { clip, LIMITS } from '../../../work/services/workLink.service.js';

// Exact strings written to WorkCategory - IPRS's own five categories.
export const WORK_CATEGORY_OPTIONS = ['Film', 'Non Film', 'BG - TV', 'BG-Film', 'AD - Jingle'];

export const WORK_CATEGORY_INPUT = {
  id: 'work-category',
  type: 'choice input',
  items: WORK_CATEGORY_OPTIONS.map((label, index) => ({ id: `work-category-${index}`, content: label })),
};

export const WORK_FILM_ALBUM_INPUT = {
  id: 'work-film-album',
  type: 'text input',
  options: { labels: { placeholder: 'e.g. Brahmastra, or "Single" if none' } },
};

export const WORK_PUBLISHER_INPUT = {
  id: 'work-publisher',
  type: 'text input',
  options: { labels: { placeholder: 'e.g. Sony Music Entertainment India Pvt. Ltd.' } },
};

export const WORK_LANGUAGE_INPUT = {
  id: 'work-language',
  type: 'text input',
  options: { labels: { placeholder: 'e.g. Hindi, English' } },
};

export const WORK_RELEASE_YEAR_INPUT = {
  id: 'work-release-year',
  type: 'text input',
  options: { labels: { placeholder: 'e.g. 2023' } },
};

const CURRENT_YEAR = new Date().getFullYear();

// Case/spacing-tolerant match against the five fixed options - a button tap always answers with the
// exact label, but a member typing the answer (or a Studio re-render) might not match case exactly.
export function parseWorkCategory(message) {
  const answer = String(message ?? '').trim().toLowerCase();
  return WORK_CATEGORY_OPTIONS.find((option) => option.toLowerCase() === answer) ?? null;
}

// Freeform text, clipped to the same column width saveWorkLink() itself uses - so an answer longer
// than the column allows is clipped instead of failing the update, exactly like every other text
// field in this table (see workLink.service.js's own clip()/LIMITS use).
export function parseFilmAlbumName(message) {
  return clip(message, LIMITS.Film_AlbumName);
}

export function parsePublisher(message) {
  return clip(message, LIMITS.Publisher);
}

export function parseLanguageNames(message) {
  return clip(message, LIMITS.LanguageNames);
}

// A 4-digit year, not in the future beyond next year (a pre-release single dated for next year is
// plausible; anything further is almost certainly a typo).
export function parseReleaseYear(message) {
  const match = /^(\d{4})$/.exec(String(message ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1900 && year <= CURRENT_YEAR + 1 ? year : null;
}

// Freeform fields are asked from the member directly, so whatever they type is the authoritative
// answer - unlike the resolved-link metadata elsewhere, there's no "grounded source" to defer to.
const FIELD_ORDER = ['Film_AlbumName', 'Publisher', 'WorkCategory', 'LanguageNames', 'ReleaseYear'];

const FIELD_CONFIG = {
  Film_AlbumName: { input: WORK_FILM_ALBUM_INPUT, parse: parseFilmAlbumName },
  Publisher: { input: WORK_PUBLISHER_INPUT, parse: parsePublisher },
  WorkCategory: { input: WORK_CATEGORY_INPUT, parse: parseWorkCategory },
  LanguageNames: { input: WORK_LANGUAGE_INPUT, parse: parseLanguageNames },
  ReleaseYear: { input: WORK_RELEASE_YEAR_INPUT, parse: parseReleaseYear },
};

const PROMPTS = {
  Film_AlbumName: (name) => `Is "${name}" from a film or an album? Type its name - or type "Single" if it's a stand-alone release.`,
  Publisher: (name) => `Who is the publisher or label for "${name}"?`,
  WorkCategory: (name) => `What type of work is "${name}"?`,
  LanguageNames: (name) => `What language(s) is "${name}" in?`,
  ReleaseYear: (name) => `What year was "${name}" released?`,
};

const RETRIES = {
  Film_AlbumName: 'Please enter the film or album name (or "Single" if there is none).',
  Publisher: 'Please enter the publisher or label name.',
  WorkCategory: 'Please choose one of the options shown.',
  LanguageNames: "That didn't look like a language - please try again.",
  ReleaseYear: "That doesn't look like a valid year - please enter a 4-digit year (e.g. 2023).",
};

// Builds the ordered list of {field, workNotificationId, songName} questions still owed for one
// member, oldest song first, each field in FIELD_ORDER. Skips a row entirely once none of its five
// fields are missing.
export function buildWorkDetailsQueue(rows) {
  const queue = [];
  for (const row of rows) {
    const songName = row.SongName ?? 'this song';
    for (const field of FIELD_ORDER) {
      if (row[field] == null) queue.push({ field, workNotificationId: row.WorkNotificationId, songName });
    }
  }
  return queue;
}

export function inputForField(field) {
  return FIELD_CONFIG[field].input;
}

export function parseForField(field, message) {
  return FIELD_CONFIG[field].parse(message);
}

export function describeWorkDetailsPrompt(task) {
  return PROMPTS[task.field](task.songName);
}

export function describeWorkDetailsRetry(task) {
  return RETRIES[task.field];
}
